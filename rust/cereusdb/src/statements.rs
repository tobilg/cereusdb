// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

//! SQL statements CereusDB executes itself instead of DataFusion:
//!
//! - database statements: `CREATE DATABASE '<url>'` / `... LOCATION '<url>'`,
//!   `ATTACH`, `DETACH`, `DROP DATABASE`, `USE`
//! - `ALTER TABLE ... RENAME TO | ADD COLUMN | DROP COLUMN | RENAME COLUMN`
//!
//! Plus Arrow IPC ingestion for `CereusDB.insertArrow()`.

use std::io::Cursor;
use std::sync::Arc;

use arrow_array::{new_null_array, Array, RecordBatch, UInt64Array};
use arrow_ipc::reader::{FileReader, StreamReader};
use arrow_schema::{Field, Schema, SchemaRef};
use datafusion::catalog::{SchemaProvider, TableProvider};
use datafusion::common::{Column, Constraints, ScalarValue, TableReference};
use datafusion::dataframe::DataFrameWriteOptions;
use datafusion::datasource::MemTable;
use datafusion::logical_expr::{cast, lit, DdlStatement, Expr, LogicalPlan};
use datafusion::prelude::SessionContext;
use datafusion::sql::parser::Statement as DFStatement;
use datafusion::sql::planner::object_name_to_table_reference;
use datafusion::sql::sqlparser::ast::{
    AlterTableOperation, Ident, ObjectName, RenameTableNameKind, Statement as SQLStatement,
};
use datafusion::sql::sqlparser::dialect::GenericDialect;
use datafusion::sql::sqlparser::tokenizer::{Token, Tokenizer};

use crate::storage::catalog::{memtable as storage_memtable, PersistentSchema, PersistentTable};
use crate::storage::DatabaseTarget;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatabaseStatement {
    Create {
        location: String,
        name: Option<String>,
        if_not_exists: bool,
    },
    Attach {
        location: String,
        alias: Option<String>,
        if_not_exists: bool,
    },
    Detach {
        name: String,
        if_exists: bool,
    },
    Drop {
        target: DatabaseTarget,
        if_exists: bool,
    },
    Use {
        parts: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// Identifier or keyword; `quoted` is true for `"quoted"` identifiers.
    Word {
        value: String,
        quoted: bool,
    },
    Str(String),
    Period,
    Colon,
    Other,
}

struct TokenCursor {
    tokens: Vec<Tok>,
    pos: usize,
}

impl TokenCursor {
    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<Tok> {
        let token = self.tokens.get(self.pos).cloned();
        self.pos += 1;
        token
    }

    fn is_keyword(&self, keyword: &str) -> bool {
        matches!(self.peek(), Some(Tok::Word { value, quoted: false }) if value.eq_ignore_ascii_case(keyword))
    }

    fn eat_keyword(&mut self, keyword: &str) -> bool {
        if self.is_keyword(keyword) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn eat_keywords(&mut self, keywords: &[&str]) -> bool {
        let start = self.pos;
        for keyword in keywords {
            if !self.eat_keyword(keyword) {
                self.pos = start;
                return false;
            }
        }
        true
    }

    fn at_end(&self) -> bool {
        self.pos >= self.tokens.len()
    }

    /// An identifier, normalized like DataFusion does (unquoted -> lowercase).
    fn identifier(&mut self) -> Option<String> {
        match self.peek()? {
            Tok::Word { value, quoted } => {
                let value = if *quoted {
                    value.clone()
                } else {
                    value.to_ascii_lowercase()
                };
                self.pos += 1;
                Some(value)
            }
            _ => None,
        }
    }
}

fn tokenize(sql: &str) -> Option<TokenCursor> {
    let tokens = Tokenizer::new(&GenericDialect {}, sql).tokenize().ok()?;
    let tokens: Vec<Tok> = tokens
        .into_iter()
        .filter_map(|token| match token {
            Token::Whitespace(_) | Token::EOF | Token::SemiColon => None,
            Token::Word(word) => Some(Tok::Word {
                quoted: word.quote_style.is_some(),
                value: word.value,
            }),
            Token::SingleQuotedString(value) => Some(Tok::Str(value)),
            Token::Period => Some(Tok::Period),
            Token::Colon => Some(Tok::Colon),
            _ => Some(Tok::Other),
        })
        .collect();
    Some(TokenCursor { tokens, pos: 0 })
}

fn looks_like_location(value: &str) -> bool {
    value.contains(":/")
}

const QUOTE_HINT: &str = "database locations must be quoted, for example 'opfs://mydb'";

/// Parse a database statement. Returns `Ok(None)` for anything else
/// (including a plain `CREATE DATABASE name`, which DataFusion handles as an
/// in-memory catalog).
pub fn parse_database_statement(sql: &str) -> Result<Option<DatabaseStatement>, String> {
    let Some(mut cursor) = tokenize(sql) else {
        return Ok(None);
    };

    if cursor.eat_keywords(&["CREATE", "DATABASE"]) {
        let if_not_exists = cursor.eat_keywords(&["IF", "NOT", "EXISTS"]);
        let statement = match cursor.next() {
            Some(Tok::Str(location)) if looks_like_location(&location) => {
                DatabaseStatement::Create {
                    location,
                    name: None,
                    if_not_exists,
                }
            }
            Some(Tok::Word { value, quoted }) => {
                if matches!(cursor.peek(), Some(Tok::Colon)) {
                    return Err(format!("Invalid CREATE DATABASE statement: {QUOTE_HINT}"));
                }
                if quoted && looks_like_location(&value) {
                    DatabaseStatement::Create {
                        location: value,
                        name: None,
                        if_not_exists,
                    }
                } else if cursor.eat_keyword("LOCATION") {
                    let Some(Tok::Str(location)) = cursor.next() else {
                        return Err(format!(
                            "Invalid CREATE DATABASE statement: expected LOCATION '<url>'; \
                             {QUOTE_HINT}"
                        ));
                    };
                    let name = if quoted {
                        value
                    } else {
                        value.to_ascii_lowercase()
                    };
                    DatabaseStatement::Create {
                        location,
                        name: Some(name),
                        if_not_exists,
                    }
                } else {
                    // Plain CREATE DATABASE: in-memory catalog via DataFusion.
                    return Ok(None);
                }
            }
            _ => return Ok(None),
        };
        return finish(cursor, statement, "CREATE DATABASE");
    }

    if cursor.eat_keyword("ATTACH") {
        cursor.eat_keyword("DATABASE");
        let if_not_exists = cursor.eat_keywords(&["IF", "NOT", "EXISTS"]);
        let location = match cursor.next() {
            Some(Tok::Str(location)) => location,
            Some(Tok::Word {
                value,
                quoted: true,
            }) => value,
            _ => {
                return Err(format!(
                    "Invalid ATTACH statement: expected ATTACH '<url>' [AS name]; {QUOTE_HINT}"
                ))
            }
        };
        let alias = if cursor.eat_keyword("AS") {
            Some(
                cursor
                    .identifier()
                    .ok_or("Invalid ATTACH statement: expected a name after AS")?,
            )
        } else {
            None
        };
        return finish(
            cursor,
            DatabaseStatement::Attach {
                location,
                alias,
                if_not_exists,
            },
            "ATTACH",
        );
    }

    if cursor.eat_keyword("DETACH") {
        cursor.eat_keyword("DATABASE");
        let if_exists = cursor.eat_keywords(&["IF", "EXISTS"]);
        let name = cursor
            .identifier()
            .ok_or("Invalid DETACH statement: expected DETACH [DATABASE] [IF EXISTS] name")?;
        return finish(
            cursor,
            DatabaseStatement::Detach { name, if_exists },
            "DETACH",
        );
    }

    if cursor.eat_keywords(&["DROP", "DATABASE"]) {
        let if_exists = cursor.eat_keywords(&["IF", "EXISTS"]);
        let target = match cursor.next() {
            Some(Tok::Str(location)) => DatabaseTarget::Location(location),
            Some(Tok::Word { value, quoted }) => {
                if matches!(cursor.peek(), Some(Tok::Colon)) {
                    return Err(format!("Invalid DROP DATABASE statement: {QUOTE_HINT}"));
                }
                if quoted && looks_like_location(&value) {
                    DatabaseTarget::Location(value)
                } else if quoted {
                    DatabaseTarget::Name(value)
                } else {
                    DatabaseTarget::Name(value.to_ascii_lowercase())
                }
            }
            _ => {
                return Err(
                    "Invalid DROP DATABASE statement: expected DROP DATABASE [IF EXISTS] name"
                        .to_string(),
                )
            }
        };
        return finish(
            cursor,
            DatabaseStatement::Drop { target, if_exists },
            "DROP DATABASE",
        );
    }

    if cursor.eat_keyword("USE") {
        let mut parts = vec![cursor
            .identifier()
            .ok_or("Invalid USE statement: expected USE database[.schema]")?];
        if matches!(cursor.peek(), Some(Tok::Period)) {
            cursor.next();
            parts.push(
                cursor
                    .identifier()
                    .ok_or("Invalid USE statement: expected USE database[.schema]")?,
            );
        }
        return finish(cursor, DatabaseStatement::Use { parts }, "USE");
    }

    Ok(None)
}

fn finish(
    cursor: TokenCursor,
    statement: DatabaseStatement,
    kind: &str,
) -> Result<Option<DatabaseStatement>, String> {
    if cursor.at_end() {
        Ok(Some(statement))
    } else {
        Err(format!(
            "Invalid {kind} statement: unexpected trailing input"
        ))
    }
}

pub(crate) fn starts_with_keyword(sql: &str, keyword: &str) -> bool {
    tokenize(sql).is_some_and(|cursor| cursor.is_keyword(keyword))
}

fn normalize_ident(ident: &Ident, normalize: bool) -> String {
    if ident.quote_style.is_none() && normalize {
        ident.value.to_ascii_lowercase()
    } else {
        ident.value.clone()
    }
}

/// Execute `ALTER TABLE`. Returns `Ok(false)` if `sql` is not an ALTER TABLE
/// statement.
pub async fn try_execute_alter_table(ctx: &SessionContext, sql: &str) -> Result<bool, String> {
    if !starts_with_keyword(sql, "ALTER") {
        return Ok(false);
    }
    let state = ctx.state();
    let options = state.config().options();
    let normalize = options.sql_parser.enable_ident_normalization;
    let statement = state
        .sql_to_statement(sql, &options.sql_parser.dialect)
        .map_err(|e| e.to_string())?;
    let DFStatement::Statement(statement) = statement else {
        return Ok(false);
    };
    let SQLStatement::AlterTable {
        name,
        if_exists,
        operations,
        ..
    } = *statement
    else {
        return Ok(false);
    };

    let table = resolve_table(ctx, name, normalize)?;
    if table
        .schema_provider()
        .table(&table.table)
        .await
        .map_err(|e| e.to_string())?
        .is_none()
    {
        if if_exists {
            return Ok(true);
        }
        return Err(format!("Table '{}' not found", table.display()));
    }

    // Operations run one after another; if one fails, restore the original
    // table so a multi-operation ALTER TABLE is all-or-nothing.
    let original = table.provider().await?;
    let mut current = ResolvedTable {
        catalog: table.catalog.clone(),
        schema: table.schema.clone(),
        table: table.table.clone(),
        schema_provider: Arc::clone(&table.schema_provider),
    };
    if let Err(e) = apply_alter_operations(ctx, &mut current, operations, normalize).await {
        if let Ok(Some(_)) = current.schema_provider.table(&current.table).await {
            let _ = current.schema_provider.deregister_table(&current.table);
        }
        let _ = table.schema_provider.deregister_table(&table.table);
        let _ = table
            .schema_provider
            .register_table(table.table.clone(), original);
        return Err(e);
    }
    Ok(true)
}

async fn apply_alter_operations(
    ctx: &SessionContext,
    table: &mut ResolvedTable,
    operations: Vec<AlterTableOperation>,
    normalize: bool,
) -> Result<(), String> {
    for operation in operations {
        match operation {
            AlterTableOperation::RenameTable { table_name } => {
                let target = match table_name {
                    RenameTableNameKind::To(name) | RenameTableNameKind::As(name) => name,
                };
                *table = rename_table(ctx, table, target, normalize).await?;
            }
            AlterTableOperation::AddColumn {
                if_not_exists,
                column_def,
                ..
            } => {
                let column = plan_column(ctx, &column_def.to_string()).await?;
                let exists = table
                    .provider()
                    .await?
                    .schema()
                    .field_with_name(column.field.name())
                    .is_ok();
                if exists {
                    if if_not_exists {
                        continue;
                    }
                    return Err(format!(
                        "Column '{}' already exists in table '{}'",
                        column.field.name(),
                        table.display()
                    ));
                }
                let fill = match &column.default {
                    Some(default) => Some(evaluate_constant(ctx, default, &column.field).await?),
                    None => None,
                };
                rebuild_table(table, |schema, batches, defaults, constraints| {
                    if !column.field.is_nullable()
                        && fill.is_none()
                        && batches.iter().any(|batch| batch.num_rows() > 0)
                    {
                        return Err(format!(
                            "Cannot add NOT NULL column '{}' without a DEFAULT to a non-empty table",
                            column.field.name()
                        ));
                    }
                    let mut fields: Vec<Field> =
                        schema.fields().iter().map(|f| f.as_ref().clone()).collect();
                    fields.push(column.field.clone());
                    let new_schema = Arc::new(Schema::new_with_metadata(
                        fields,
                        schema.metadata().clone(),
                    ));
                    let new_batches = batches
                        .iter()
                        .map(|batch| {
                            let mut columns = batch.columns().to_vec();
                            columns.push(match &fill {
                                Some(value) => value
                                    .to_array_of_size(batch.num_rows())
                                    .map_err(|e| e.to_string())?,
                                None => new_null_array(column.field.data_type(), batch.num_rows()),
                            });
                            RecordBatch::try_new(Arc::clone(&new_schema), columns)
                                .map_err(|e| e.to_string())
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                    let mut defaults = defaults;
                    if let Some(default) = &column.default {
                        defaults.push((column.field.name().clone(), default.clone()));
                    }
                    Ok((new_schema, new_batches, defaults, constraints))
                })
                .await?;
            }
            AlterTableOperation::DropColumn {
                column_names,
                if_exists,
                ..
            } => {
                let names: Vec<String> = column_names
                    .iter()
                    .map(|ident| normalize_ident(ident, normalize))
                    .collect();
                let schema = table.provider().await?.schema();
                let mut drop = Vec::new();
                for name in &names {
                    match schema.index_of(name) {
                        Ok(index) => drop.push(index),
                        Err(_) if if_exists => {}
                        Err(_) => {
                            return Err(format!(
                                "Column '{name}' does not exist in table '{}'",
                                table.display()
                            ))
                        }
                    }
                }
                if drop.is_empty() {
                    continue;
                }
                let keep: Vec<usize> = (0..schema.fields().len())
                    .filter(|index| !drop.contains(index))
                    .collect();
                if keep.is_empty() {
                    return Err(format!(
                        "Cannot drop all columns of table '{}'",
                        table.display()
                    ));
                }
                rebuild_table(table, |schema, batches, defaults, constraints| {
                    let new_schema = Arc::new(schema.project(&keep).map_err(|e| e.to_string())?);
                    let new_batches = batches
                        .iter()
                        .map(|batch| batch.project(&keep).map_err(|e| e.to_string()))
                        .collect::<Result<Vec<_>, String>>()?;
                    let defaults = defaults
                        .into_iter()
                        .filter(|(name, _)| new_schema.field_with_name(name).is_ok())
                        .collect();
                    let constraints = constraints.project(&keep).unwrap_or_default();
                    Ok((new_schema, new_batches, defaults, constraints))
                })
                .await?;
            }
            AlterTableOperation::RenameColumn {
                old_column_name,
                new_column_name,
            } => {
                let old_name = normalize_ident(&old_column_name, normalize);
                let new_name = normalize_ident(&new_column_name, normalize);
                rebuild_table(table, |schema, batches, defaults, constraints| {
                    let index = schema.index_of(&old_name).map_err(|_| {
                        format!(
                            "Column '{old_name}' does not exist in table '{}'",
                            table.display()
                        )
                    })?;
                    if schema.field_with_name(&new_name).is_ok() {
                        return Err(format!(
                            "Column '{new_name}' already exists in table '{}'",
                            table.display()
                        ));
                    }
                    let fields: Vec<Field> = schema
                        .fields()
                        .iter()
                        .enumerate()
                        .map(|(i, field)| {
                            let field = field.as_ref().clone();
                            if i == index {
                                field.with_name(new_name.clone())
                            } else {
                                field
                            }
                        })
                        .collect();
                    let new_schema =
                        Arc::new(Schema::new_with_metadata(fields, schema.metadata().clone()));
                    let new_batches = batches
                        .iter()
                        .map(|batch| {
                            RecordBatch::try_new(Arc::clone(&new_schema), batch.columns().to_vec())
                                .map_err(|e| e.to_string())
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                    let defaults = defaults
                        .into_iter()
                        .map(|(name, expr)| {
                            if name == old_name {
                                (new_name.clone(), expr)
                            } else {
                                (name, expr)
                            }
                        })
                        .collect();
                    Ok((new_schema, new_batches, defaults, constraints))
                })
                .await?;
            }
            other => {
                return Err(format!(
                    "Unsupported ALTER TABLE operation: {other}. Supported: RENAME TO, \
                     ADD COLUMN, DROP COLUMN, RENAME COLUMN"
                ))
            }
        }
    }
    Ok(())
}

/// A table location resolved against the session defaults.
struct ResolvedTable {
    catalog: String,
    schema: String,
    table: String,
    schema_provider: Arc<dyn SchemaProvider>,
}

impl ResolvedTable {
    fn display(&self) -> String {
        format!("{}.{}.{}", self.catalog, self.schema, self.table)
    }

    fn schema_provider(&self) -> &Arc<dyn SchemaProvider> {
        &self.schema_provider
    }

    async fn provider(&self) -> Result<Arc<dyn TableProvider>, String> {
        self.schema_provider
            .table(&self.table)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Table '{}' not found", self.display()))
    }
}

fn resolve_reference(
    ctx: &SessionContext,
    reference: TableReference,
) -> Result<ResolvedTable, String> {
    let state = ctx.state();
    let options = state.config().options();
    let resolved = reference.resolve(
        &options.catalog.default_catalog,
        &options.catalog.default_schema,
    );
    let catalog = ctx
        .catalog(&resolved.catalog)
        .ok_or_else(|| format!("Database '{}' not found", resolved.catalog))?;
    let schema_provider = catalog.schema(&resolved.schema).ok_or_else(|| {
        format!(
            "Schema '{}.{}' not found",
            resolved.catalog, resolved.schema
        )
    })?;
    Ok(ResolvedTable {
        catalog: resolved.catalog.to_string(),
        schema: resolved.schema.to_string(),
        table: resolved.table.to_string(),
        schema_provider,
    })
}

fn resolve_table(
    ctx: &SessionContext,
    name: ObjectName,
    normalize: bool,
) -> Result<ResolvedTable, String> {
    let reference = object_name_to_table_reference(name, normalize).map_err(|e| e.to_string())?;
    resolve_reference(ctx, reference)
}

async fn rename_table(
    ctx: &SessionContext,
    source: &ResolvedTable,
    target: ObjectName,
    normalize: bool,
) -> Result<ResolvedTable, String> {
    let reference = object_name_to_table_reference(target, normalize).map_err(|e| e.to_string())?;
    // An unqualified or partially qualified target stays in the source's
    // catalog/schema rather than moving to the session default.
    let reference = match reference {
        TableReference::Bare { table } => {
            TableReference::full(source.catalog.as_str(), source.schema.as_str(), table)
        }
        TableReference::Partial { schema, table } => {
            TableReference::full(source.catalog.as_str(), schema, table)
        }
        full => full,
    };
    let target = resolve_reference(ctx, reference)?;
    if target.schema_provider.table_exist(&target.table) {
        return Err(format!("Table '{}' already exists", target.display()));
    }

    let provider = source.provider().await?;
    let moved = match provider.as_any().downcast_ref::<PersistentTable>() {
        Some(table) => {
            let target_database = target
                .schema_provider
                .as_any()
                .downcast_ref::<PersistentSchema>()
                .map(|schema| Arc::clone(schema.state()));
            match target_database {
                // Renamed within its database: only the manifest changes.
                Some(state) if Arc::ptr_eq(&state, &table.state) => Arc::clone(&provider),
                // Moved to another database: its data is needed (and loaded now).
                Some(_) => {
                    table.data().await.map_err(|e| e.to_string())?;
                    Arc::clone(&provider)
                }
                // Leaving persistent storage: keep the data as an in-memory table.
                None => table.data().await.map_err(|e| e.to_string())?,
            }
        }
        None => Arc::clone(&provider),
    };

    source
        .schema_provider
        .deregister_table(&source.table)
        .map_err(|e| e.to_string())?;
    if let Err(e) = target
        .schema_provider
        .register_table(target.table.clone(), moved)
    {
        let _ = source
            .schema_provider
            .register_table(source.table.clone(), provider);
        return Err(e.to_string());
    }
    Ok(target)
}

type ColumnDefaults = Vec<(String, Expr)>;

/// Replace a table with a rebuilt in-memory table. Works for plain in-memory
/// tables and for tables of persistent databases (which then get rewritten).
async fn rebuild_table<F>(table: &ResolvedTable, rebuild: F) -> Result<(), String>
where
    F: FnOnce(
        &SchemaRef,
        &[RecordBatch],
        ColumnDefaults,
        Constraints,
    ) -> Result<(SchemaRef, Vec<RecordBatch>, ColumnDefaults, Constraints), String>,
{
    let provider = table.provider().await?;
    let data = match provider.as_any().downcast_ref::<PersistentTable>() {
        Some(persistent) => persistent.data().await.map_err(|e| e.to_string())?,
        None if provider.as_any().is::<MemTable>() => Arc::clone(&provider),
        None => {
            return Err(format!(
                "ALTER TABLE can only change the columns of in-memory and database tables; \
                 '{}' is a {:?} table",
                table.display(),
                provider.table_type()
            ))
        }
    };
    let memtable = storage_memtable(&data).map_err(|e| e.to_string())?;

    let schema = provider.schema();
    let mut batches = Vec::new();
    for partition in &memtable.batches {
        batches.extend(partition.read().await.iter().cloned());
    }
    let defaults: ColumnDefaults = schema
        .fields()
        .iter()
        .filter_map(|field| {
            provider
                .get_column_default(field.name())
                .map(|expr| (field.name().clone(), expr.clone()))
        })
        .collect();
    let constraints = provider.constraints().cloned().unwrap_or_default();

    let (new_schema, new_batches, defaults, constraints) =
        rebuild(&schema, &batches, defaults, constraints)?;
    let new_table = MemTable::try_new(new_schema, vec![new_batches])
        .map_err(|e| e.to_string())?
        .with_constraints(constraints)
        .with_column_defaults(defaults.into_iter().collect());

    table
        .schema_provider
        .deregister_table(&table.table)
        .map_err(|e| e.to_string())?;
    if let Err(e) = table
        .schema_provider
        .register_table(table.table.clone(), Arc::new(new_table))
    {
        let _ = table
            .schema_provider
            .register_table(table.table.clone(), provider);
        return Err(e.to_string());
    }
    Ok(())
}

struct PlannedColumn {
    field: Field,
    default: Option<Expr>,
}

/// Plan a column definition by planning `CREATE TABLE t (<column_def>)`, so
/// types, NOT NULL and DEFAULT follow DataFusion's own rules.
async fn plan_column(ctx: &SessionContext, column_def: &str) -> Result<PlannedColumn, String> {
    let sql = format!("CREATE TABLE __cereusdb_alter_column ({column_def})");
    let plan = ctx
        .state()
        .create_logical_plan(&sql)
        .await
        .map_err(|e| e.to_string())?;
    let LogicalPlan::Ddl(DdlStatement::CreateMemoryTable(create)) = plan else {
        return Err(format!("Invalid column definition: {column_def}"));
    };
    let field = create.input.schema().inner().field(0).as_ref().clone();
    let default = create
        .column_defaults
        .into_iter()
        .find(|(name, _)| name == field.name())
        .map(|(_, expr)| expr);
    Ok(PlannedColumn { field, default })
}

async fn evaluate_constant(
    ctx: &SessionContext,
    expr: &Expr,
    field: &Field,
) -> Result<ScalarValue, String> {
    let batches = ctx
        .read_empty()
        .and_then(|df| {
            df.select(vec![
                cast(expr.clone(), field.data_type().clone()).alias("v")
            ])
        })
        .map_err(|e| e.to_string())?
        .collect()
        .await
        .map_err(|e| format!("DEFAULT must be a constant expression: {e}"))?;
    let column = batches
        .first()
        .filter(|batch| batch.num_rows() == 1)
        .map(|batch| Arc::clone(batch.column(0)))
        .ok_or("DEFAULT must be a constant expression")?;
    ScalarValue::try_from_array(&column, 0).map_err(|e| e.to_string())
}

fn decode_ipc(data: &[u8]) -> Result<(SchemaRef, Vec<RecordBatch>), String> {
    if data.starts_with(b"ARROW1") {
        let reader = FileReader::try_new(Cursor::new(data.to_vec()), None)
            .map_err(|e| format!("Invalid Arrow IPC file: {e}"))?;
        let schema = reader.schema();
        let batches = reader
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Invalid Arrow IPC file: {e}"))?;
        Ok((schema, batches))
    } else {
        let reader = StreamReader::try_new(Cursor::new(data.to_vec()), None)
            .map_err(|e| format!("Invalid Arrow IPC stream: {e}"))?;
        let schema = reader.schema();
        let batches = reader
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Invalid Arrow IPC stream: {e}"))?;
        Ok((schema, batches))
    }
}

/// Insert Arrow IPC data (stream or file format) into a table, matching
/// columns by name. Missing columns are filled with NULL. Returns the number
/// of inserted rows.
pub async fn insert_arrow(
    ctx: &SessionContext,
    table_name: &str,
    data: &[u8],
) -> Result<u64, String> {
    let (source, batches) = decode_ipc(data)?;
    let provider = ctx
        .table_provider(table_name)
        .await
        .map_err(|e| e.to_string())?;
    let target = provider.schema();
    for field in source.fields() {
        if target.field_with_name(field.name()).is_err() {
            return Err(format!(
                "Column '{}' does not exist in table '{table_name}'",
                field.name()
            ));
        }
    }
    let batches: Vec<RecordBatch> = batches
        .into_iter()
        .filter(|batch| batch.num_rows() > 0)
        .collect();
    if batches.is_empty() {
        return Ok(0);
    }

    let mut projection = Vec::with_capacity(target.fields().len());
    for field in target.fields() {
        let expr = if source.field_with_name(field.name()).is_ok() {
            cast(
                Expr::Column(Column::from_name(field.name())),
                field.data_type().clone(),
            )
        } else {
            lit(ScalarValue::try_from(field.data_type()).map_err(|e| e.to_string())?)
        };
        projection.push(expr.alias(field.name()));
    }

    let result = ctx
        .read_batches(batches)
        .and_then(|df| df.select(projection))
        .map_err(|e| e.to_string())?
        .write_table(table_name, DataFrameWriteOptions::new())
        .await
        .map_err(|e| e.to_string())?;
    Ok(result
        .first()
        .and_then(|batch| batch.column(0).as_any().downcast_ref::<UInt64Array>())
        .filter(|counts| !counts.is_empty())
        .map(|counts| counts.value(0))
        .unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(sql: &str) -> Option<DatabaseStatement> {
        parse_database_statement(sql).unwrap()
    }

    #[test]
    fn parses_create_database() {
        assert_eq!(
            parse("CREATE DATABASE 'opfs://mydb'"),
            Some(DatabaseStatement::Create {
                location: "opfs://mydb".into(),
                name: None,
                if_not_exists: false
            })
        );
        assert_eq!(
            parse("create database if not exists MyDb location 'opfs://x';"),
            Some(DatabaseStatement::Create {
                location: "opfs://x".into(),
                name: Some("mydb".into()),
                if_not_exists: true
            })
        );
        assert_eq!(parse("CREATE DATABASE plain"), None);
        assert_eq!(parse("CREATE TABLE t (id INT)"), None);
        assert!(parse_database_statement("CREATE DATABASE opfs://mydb").is_err());
    }

    #[test]
    fn parses_attach_detach_drop_use() {
        assert_eq!(
            parse("ATTACH 'opfs://mydb' AS other"),
            Some(DatabaseStatement::Attach {
                location: "opfs://mydb".into(),
                alias: Some("other".into()),
                if_not_exists: false
            })
        );
        assert_eq!(
            parse("DETACH DATABASE IF EXISTS mydb"),
            Some(DatabaseStatement::Detach {
                name: "mydb".into(),
                if_exists: true
            })
        );
        assert_eq!(
            parse("DROP DATABASE 'opfs://mydb'"),
            Some(DatabaseStatement::Drop {
                target: DatabaseTarget::Location("opfs://mydb".into()),
                if_exists: false
            })
        );
        assert_eq!(
            parse("USE mydb.Staging"),
            Some(DatabaseStatement::Use {
                parts: vec!["mydb".into(), "staging".into()]
            })
        );
        assert_eq!(parse("SELECT 1"), None);
        assert!(parse_database_statement("ATTACH mydb").is_err());
    }
}
