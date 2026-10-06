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

//! Catalog introspection: the `cereusdb_databases()` table function and the
//! structured catalog returned by `CereusDB.catalog()`.

use std::sync::Arc;

use arrow_array::{ArrayRef, RecordBatch, StringArray, UInt64Array};
use arrow_schema::{DataType, Field, Schema};
use datafusion::catalog::{CatalogProviderList, TableFunctionImpl, TableProvider};
use datafusion::common::{plan_err, Result};
use datafusion::datasource::{MemTable, TableType};
use datafusion::logical_expr::Expr;
use serde::Serialize;

use super::catalog::CereusCatalogList;
use super::DatabaseRegistry;

pub fn console_warn(message: &str) {
    #[cfg(target_arch = "wasm32")]
    web_sys::console::warn_1(&wasm_bindgen::JsValue::from_str(message));
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{message}");
}

/// `SELECT * FROM cereusdb_databases()`: one row per database (catalog).
#[derive(Debug)]
pub struct DatabasesFunction {
    catalog_list: Arc<CereusCatalogList>,
    registry: Arc<DatabaseRegistry>,
}

impl DatabasesFunction {
    pub fn new(catalog_list: Arc<CereusCatalogList>, registry: Arc<DatabaseRegistry>) -> Self {
        Self {
            catalog_list,
            registry,
        }
    }
}

impl TableFunctionImpl for DatabasesFunction {
    fn call(&self, args: &[Expr]) -> Result<Arc<dyn TableProvider>> {
        if !args.is_empty() {
            return plan_err!("cereusdb_databases() takes no arguments");
        }

        let mut names = Vec::new();
        let mut storages = Vec::new();
        let mut locations = Vec::new();
        let mut schema_counts = Vec::new();
        let mut table_counts = Vec::new();
        for name in self.catalog_list.catalog_names() {
            let Some(catalog) = self.catalog_list.catalog(&name) else {
                continue;
            };
            let schema_names = catalog.schema_names();
            let table_count: usize = schema_names
                .iter()
                .filter_map(|schema| catalog.schema(schema))
                .map(|schema| schema.table_names().len())
                .sum();
            let persistent = self.registry.get(&name);
            storages.push(
                persistent
                    .as_ref()
                    .map(|db| db.state.scheme.clone())
                    .unwrap_or_else(|| "memory".to_string()),
            );
            locations.push(persistent.map(|db| db.state.location.clone()));
            names.push(name);
            schema_counts.push(schema_names.len() as u64);
            table_counts.push(table_count as u64);
        }

        let schema = Arc::new(Schema::new(vec![
            Field::new("database_name", DataType::Utf8, false),
            Field::new("storage", DataType::Utf8, false),
            Field::new("location", DataType::Utf8, true),
            Field::new("schema_count", DataType::UInt64, false),
            Field::new("table_count", DataType::UInt64, false),
        ]));
        let columns: Vec<ArrayRef> = vec![
            Arc::new(StringArray::from(names)),
            Arc::new(StringArray::from(storages)),
            Arc::new(StringArray::from(locations)),
            Arc::new(UInt64Array::from(schema_counts)),
            Arc::new(UInt64Array::from(table_counts)),
        ];
        let batch = RecordBatch::try_new(Arc::clone(&schema), columns)?;
        Ok(Arc::new(MemTable::try_new(schema, vec![vec![batch]])?))
    }
}

#[derive(Debug, Serialize)]
pub struct DatabaseInfo {
    pub name: String,
    pub storage: String,
    pub location: Option<String>,
    pub schemas: Vec<SchemaInfo>,
}

#[derive(Debug, Serialize)]
pub struct SchemaInfo {
    pub name: String,
    pub tables: Vec<TableInfo>,
}

#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub table_type: String,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
}

/// Describe every database, schema, table and view.
pub async fn describe_catalog(
    catalog_list: &CereusCatalogList,
    registry: &DatabaseRegistry,
) -> Result<Vec<DatabaseInfo>> {
    let mut databases = Vec::new();
    for name in catalog_list.catalog_names() {
        let Some(catalog) = catalog_list.catalog(&name) else {
            continue;
        };
        let persistent = registry.get(&name);
        let mut schemas = Vec::new();
        let mut schema_names = catalog.schema_names();
        schema_names.sort();
        for schema_name in schema_names {
            let Some(schema) = catalog.schema(&schema_name) else {
                continue;
            };
            let mut tables = Vec::new();
            let mut table_names = schema.table_names();
            table_names.sort();
            for table_name in table_names {
                let Some(table) = schema.table(&table_name).await? else {
                    continue;
                };
                tables.push(TableInfo {
                    name: table_name,
                    table_type: table_type_name(table.table_type()).to_string(),
                    columns: table
                        .schema()
                        .fields()
                        .iter()
                        .map(|field| ColumnInfo {
                            name: field.name().clone(),
                            data_type: field.data_type().to_string(),
                            nullable: field.is_nullable(),
                            extension: field.metadata().get("ARROW:extension:name").cloned(),
                        })
                        .collect(),
                });
            }
            schemas.push(SchemaInfo {
                name: schema_name,
                tables,
            });
        }
        databases.push(DatabaseInfo {
            storage: persistent
                .as_ref()
                .map(|db| db.state.scheme.clone())
                .unwrap_or_else(|| "memory".to_string()),
            location: persistent.map(|db| db.state.location.clone()),
            name,
            schemas,
        });
    }
    Ok(databases)
}

fn table_type_name(table_type: TableType) -> &'static str {
    match table_type {
        TableType::Base => "BASE TABLE",
        TableType::View => "VIEW",
        TableType::Temporary => "LOCAL TEMPORARY",
    }
}
