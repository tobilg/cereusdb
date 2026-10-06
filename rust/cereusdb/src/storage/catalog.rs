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

//! DataFusion catalog providers backed by a persistent database.
//!
//! All data is held in memory (as [`MemTable`]s) and every change is recorded
//! as pending work on the shared [`DatabaseState`]. The [`super::StorageManager`]
//! writes that work to the storage backend after each statement.

use std::any::Any;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use arrow_array::RecordBatch;
use arrow_schema::SchemaRef;
use async_trait::async_trait;
use datafusion::catalog::{
    CatalogProvider, CatalogProviderList, SchemaProvider, Session, TableProvider,
};
use datafusion::common::{
    exec_err, not_impl_err, plan_err, Constraint, Constraints, Result, SchemaExt,
};
use datafusion::datasource::sink::{DataSink, DataSinkExec};
use datafusion::datasource::{MemTable, TableType, ViewTable};
use datafusion::execution::{SendableRecordBatchStream, TaskContext};
use datafusion::logical_expr::dml::InsertOp;
use datafusion::logical_expr::Expr;
use datafusion::physical_plan::{DisplayAs, DisplayFormatType, ExecutionPlan};
use datafusion::sql::unparser::expr_to_sql;
use futures::StreamExt;

use super::backend::read_file_detached;
use super::info::console_warn;
use super::manifest::{
    align_batch, decode_segment, encode_schema, segment_path, ConstraintManifest, Manifest,
    SchemaManifest, SegmentManifest, TableManifest, ViewManifest,
};

static NEXT_TABLE_ID: AtomicU64 = AtomicU64::new(1);

fn next_table_id() -> u64 {
    NEXT_TABLE_ID.fetch_add(1, Ordering::Relaxed)
}

/// Work recorded for one table since the last flush.
#[derive(Debug)]
pub enum PendingOp {
    /// Rows appended by INSERT; written as one new segment.
    Append(Vec<RecordBatch>),
    /// The table changed in place (or is new); rewritten as one segment.
    Rewrite,
}

#[derive(Debug, Default)]
pub struct PendingWork {
    pub ops: Vec<(u64, PendingOp)>,
}

#[derive(Debug)]
struct MutableState {
    next_segment_id: u64,
    pending: HashMap<u64, PendingOp>,
    /// Pending ops in first-recorded order, so segments are written in order.
    order: Vec<u64>,
    dirty: bool,
    /// Segment ids referenced by the last manifest that was written.
    committed: HashSet<u64>,
}

/// State shared by all providers of one persistent database.
#[derive(Debug)]
pub struct DatabaseState {
    pub name: String,
    pub location: String,
    pub scheme: String,
    pub root: String,
    /// Id of the storage backend (see [`super::backend::register_backend`]),
    /// used to load table data on first use.
    pub backend_id: u64,
    mutable: Mutex<MutableState>,
}

impl DatabaseState {
    pub fn new(
        name: String,
        scheme: String,
        root: String,
        backend_id: u64,
        manifest: &Manifest,
    ) -> Self {
        Self {
            location: format!("{scheme}://{root}"),
            name,
            scheme,
            root,
            backend_id,
            mutable: Mutex::new(MutableState {
                next_segment_id: manifest.next_segment_id.max(1),
                pending: HashMap::new(),
                order: Vec::new(),
                dirty: false,
                committed: manifest.segment_ids().collect(),
            }),
        }
    }

    pub fn lock_name(&self) -> String {
        format!("cereusdb:{}", self.location)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, MutableState> {
        self.mutable.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn mark_dirty(&self) {
        self.state().dirty = true;
    }

    pub fn record_append(&self, table_id: u64, batches: Vec<RecordBatch>) {
        let mut state = self.state();
        state.dirty = true;
        match state.pending.get_mut(&table_id) {
            Some(PendingOp::Append(existing)) => existing.extend(batches),
            Some(PendingOp::Rewrite) => {}
            None => {
                state.order.push(table_id);
                state.pending.insert(table_id, PendingOp::Append(batches));
            }
        }
    }

    pub fn record_rewrite(&self, table_id: u64) {
        let mut state = self.state();
        state.dirty = true;
        if state.pending.insert(table_id, PendingOp::Rewrite).is_none() {
            state.order.push(table_id);
        }
    }

    /// Drop a pending append for `table_id` because a rewrite just captured
    /// the table contents (including those rows).
    pub fn discard_pending_append(&self, table_id: u64) {
        let mut state = self.state();
        if matches!(state.pending.get(&table_id), Some(PendingOp::Append(_))) {
            state.pending.remove(&table_id);
            state.order.retain(|id| *id != table_id);
        }
    }

    pub fn take_work(&self) -> Option<PendingWork> {
        let mut state = self.state();
        if !state.dirty && state.pending.is_empty() {
            return None;
        }
        state.dirty = false;
        let order = std::mem::take(&mut state.order);
        let mut pending = std::mem::take(&mut state.pending);
        let ops = order
            .into_iter()
            .filter_map(|id| pending.remove(&id).map(|op| (id, op)))
            .collect();
        Some(PendingWork { ops })
    }

    pub fn allocate_segment_id(&self) -> u64 {
        let mut state = self.state();
        let id = state.next_segment_id;
        state.next_segment_id += 1;
        id
    }

    pub fn next_segment_id(&self) -> u64 {
        self.state().next_segment_id
    }

    pub fn committed_segments(&self) -> HashSet<u64> {
        self.state().committed.clone()
    }

    pub fn set_committed_segments(&self, committed: HashSet<u64>) {
        self.state().committed = committed;
    }
}

/// Catalog list that also supports removing catalogs (DETACH / DROP DATABASE).
#[derive(Debug, Default)]
pub struct CereusCatalogList {
    catalogs: RwLock<BTreeMap<String, Arc<dyn CatalogProvider>>>,
}

impl CereusCatalogList {
    pub fn from_existing(existing: &Arc<dyn CatalogProviderList>) -> Self {
        let list = Self::default();
        for name in existing.catalog_names() {
            if let Some(catalog) = existing.catalog(&name) {
                list.register_catalog(name, catalog);
            }
        }
        list
    }

    pub fn deregister_catalog(&self, name: &str) -> Option<Arc<dyn CatalogProvider>> {
        self.catalogs
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(name)
    }
}

impl CatalogProviderList for CereusCatalogList {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn register_catalog(
        &self,
        name: String,
        catalog: Arc<dyn CatalogProvider>,
    ) -> Option<Arc<dyn CatalogProvider>> {
        self.catalogs
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name, catalog)
    }

    fn catalog_names(&self) -> Vec<String> {
        self.catalogs
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect()
    }

    fn catalog(&self, name: &str) -> Option<Arc<dyn CatalogProvider>> {
        self.catalogs
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(name)
            .cloned()
    }
}

/// A persistent database, exposed to DataFusion as a catalog.
#[derive(Debug)]
pub struct PersistentCatalog {
    pub state: Arc<DatabaseState>,
    schemas: RwLock<BTreeMap<String, Arc<PersistentSchema>>>,
}

impl PersistentCatalog {
    pub fn new(state: Arc<DatabaseState>) -> Self {
        Self {
            state,
            schemas: RwLock::new(BTreeMap::new()),
        }
    }

    /// Add a schema while loading a database (does not mark the database dirty).
    pub fn insert_loaded_schema(&self, name: &str) -> Arc<PersistentSchema> {
        let schema = Arc::new(PersistentSchema::new(Arc::clone(&self.state)));
        self.schemas
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name.to_string(), Arc::clone(&schema));
        schema
    }

    pub fn persistent_schemas(&self) -> Vec<(String, Arc<PersistentSchema>)> {
        self.schemas
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(name, schema)| (name.clone(), Arc::clone(schema)))
            .collect()
    }

    pub fn tables_by_id(&self) -> HashMap<u64, Arc<PersistentTable>> {
        self.persistent_schemas()
            .into_iter()
            .flat_map(|(_, schema)| schema.persistent_tables())
            .map(|(_, table)| (table.id, table))
            .collect()
    }

    /// Build the manifest describing the current in-memory state.
    ///
    /// Tables that have not been written yet (no segments) are left out; they
    /// are added by the flush that writes their first segment.
    pub fn build_manifest(&self) -> Manifest {
        let mut manifest = Manifest::new_database();
        manifest.schemas.clear();
        manifest.next_segment_id = self.state.next_segment_id();
        for (schema_name, schema) in self.persistent_schemas() {
            let mut entry = SchemaManifest::default();
            for (table_name, table) in schema.persistent_tables() {
                if let Some(table_manifest) = table.manifest() {
                    entry.tables.insert(table_name, table_manifest);
                }
            }
            for (view_name, sql, view_schema) in schema.view_definitions() {
                // An unresolved view without a known schema has no columns.
                let schema = (!view_schema.fields().is_empty())
                    .then(|| encode_schema(&view_schema).ok())
                    .flatten();
                entry.views.insert(view_name, ViewManifest { sql, schema });
            }
            manifest.schemas.insert(schema_name, entry);
        }
        manifest
    }
}

impl CatalogProvider for PersistentCatalog {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn schema_names(&self) -> Vec<String> {
        self.schemas
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect()
    }

    fn schema(&self, name: &str) -> Option<Arc<dyn SchemaProvider>> {
        self.schemas
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(name)
            .map(|schema| Arc::clone(schema) as Arc<dyn SchemaProvider>)
    }

    fn register_schema(
        &self,
        name: &str,
        schema: Arc<dyn SchemaProvider>,
    ) -> Result<Option<Arc<dyn SchemaProvider>>> {
        if !schema.table_names().is_empty() {
            return plan_err!(
                "Cannot register a non-empty schema in database '{}'",
                self.state.name
            );
        }
        let previous = self
            .schemas
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                name.to_string(),
                Arc::new(PersistentSchema::new(Arc::clone(&self.state))),
            );
        self.state.mark_dirty();
        Ok(previous.map(|schema| schema as Arc<dyn SchemaProvider>))
    }

    fn deregister_schema(
        &self,
        name: &str,
        cascade: bool,
    ) -> Result<Option<Arc<dyn SchemaProvider>>> {
        let mut schemas = self.schemas.write().unwrap_or_else(|e| e.into_inner());
        let Some(schema) = schemas.get(name) else {
            return Ok(None);
        };
        let table_names = schema.table_names();
        if !table_names.is_empty() && !cascade {
            return exec_err!(
                "Cannot drop schema {} because other tables depend on it: {}",
                name,
                table_names.join(", ")
            );
        }
        let removed = schemas.remove(name);
        self.state.mark_dirty();
        Ok(removed.map(|schema| schema as Arc<dyn SchemaProvider>))
    }
}

#[derive(Debug, Clone)]
enum SchemaEntry {
    Table(Arc<PersistentTable>),
    View {
        provider: Arc<dyn TableProvider>,
        sql: String,
    },
}

impl SchemaEntry {
    fn provider(&self) -> Arc<dyn TableProvider> {
        match self {
            SchemaEntry::Table(table) => Arc::clone(table) as Arc<dyn TableProvider>,
            SchemaEntry::View { provider, .. } => Arc::clone(provider),
        }
    }
}

/// A schema inside a persistent database.
#[derive(Debug)]
pub struct PersistentSchema {
    state: Arc<DatabaseState>,
    entries: RwLock<BTreeMap<String, SchemaEntry>>,
}

impl PersistentSchema {
    fn new(state: Arc<DatabaseState>) -> Self {
        Self {
            state,
            entries: RwLock::new(BTreeMap::new()),
        }
    }

    pub fn state(&self) -> &Arc<DatabaseState> {
        &self.state
    }

    fn entries(&self) -> std::sync::RwLockReadGuard<'_, BTreeMap<String, SchemaEntry>> {
        self.entries.read().unwrap_or_else(|e| e.into_inner())
    }

    fn entries_mut(&self) -> std::sync::RwLockWriteGuard<'_, BTreeMap<String, SchemaEntry>> {
        self.entries.write().unwrap_or_else(|e| e.into_inner())
    }

    pub fn insert_loaded_table(&self, name: &str, table: Arc<PersistentTable>) {
        self.entries_mut()
            .insert(name.to_string(), SchemaEntry::Table(table));
    }

    pub fn insert_loaded_view(&self, name: &str, provider: Arc<dyn TableProvider>, sql: String) {
        self.entries_mut()
            .insert(name.to_string(), SchemaEntry::View { provider, sql });
    }

    /// Add a stored view whose definition could not be planned (for example
    /// because it uses a table that does not exist). It stays listed and
    /// droppable; queries fail with `reason`.
    pub fn insert_unresolved_view(
        &self,
        name: &str,
        sql: String,
        schema: Option<SchemaRef>,
        reason: String,
    ) {
        let provider = Arc::new(UnresolvedView {
            sql: sql.clone(),
            reason,
            schema: schema.unwrap_or_else(|| Arc::new(arrow_schema::Schema::empty())),
        });
        self.entries_mut()
            .insert(name.to_string(), SchemaEntry::View { provider, sql });
    }

    pub fn persistent_tables(&self) -> Vec<(String, Arc<PersistentTable>)> {
        self.entries()
            .iter()
            .filter_map(|(name, entry)| match entry {
                SchemaEntry::Table(table) => Some((name.clone(), Arc::clone(table))),
                SchemaEntry::View { .. } => None,
            })
            .collect()
    }

    /// Stored views: name, SQL definition and output schema.
    pub fn view_definitions(&self) -> Vec<(String, String, SchemaRef)> {
        self.entries()
            .iter()
            .filter_map(|(name, entry)| match entry {
                SchemaEntry::View { provider, sql } => {
                    Some((name.clone(), sql.clone(), provider.schema()))
                }
                SchemaEntry::Table(_) => None,
            })
            .collect()
    }

    fn to_entry(&self, name: &str, table: Arc<dyn TableProvider>) -> Result<SchemaEntry> {
        let any = table.as_any();
        if let Some(persistent) = any.downcast_ref::<PersistentTable>() {
            if Arc::ptr_eq(&persistent.state, &self.state) {
                return Ok(SchemaEntry::Table(Arc::new(persistent.clone_handle())));
            }
            // Moved in from another database: take over its data and rewrite.
            let Some(data) = persistent.loaded_data() else {
                return plan_err!("Table '{name}' must be loaded before it can be moved");
            };
            let table = Arc::new(PersistentTable::from_memtable(
                Arc::clone(&self.state),
                data,
            ));
            self.state.record_rewrite(table.id);
            return Ok(SchemaEntry::Table(table));
        }
        if any.is::<MemTable>() {
            let table = Arc::new(PersistentTable::from_memtable(
                Arc::clone(&self.state),
                table,
            ));
            self.state.record_rewrite(table.id);
            return Ok(SchemaEntry::Table(table));
        }
        if let Some(view) = any.downcast_ref::<UnresolvedView>() {
            return Ok(SchemaEntry::View {
                sql: view.sql.clone(),
                provider: table,
            });
        }
        if let Some(view) = any.downcast_ref::<ViewTable>() {
            let Some(sql) = view.definition() else {
                return plan_err!(
                    "View '{name}' has no SQL definition and cannot be stored in database '{}'",
                    self.state.name
                );
            };
            return Ok(SchemaEntry::View {
                sql: sql.clone(),
                provider: table,
            });
        }
        plan_err!(
            "Database '{}' ({}) can only store tables and views; '{name}' is a {:?} provider. \
             Use CREATE TABLE ... AS SELECT to copy the data into the database",
            self.state.name,
            self.state.location,
            table.table_type()
        )
    }
}

#[async_trait]
impl SchemaProvider for PersistentSchema {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn table_names(&self) -> Vec<String> {
        self.entries().keys().cloned().collect()
    }

    async fn table(&self, name: &str) -> Result<Option<Arc<dyn TableProvider>>> {
        Ok(self.entries().get(name).map(SchemaEntry::provider))
    }

    fn register_table(
        &self,
        name: String,
        table: Arc<dyn TableProvider>,
    ) -> Result<Option<Arc<dyn TableProvider>>> {
        if self.table_exist(&name) {
            return exec_err!("The table {name} already exists");
        }
        let entry = self.to_entry(&name, table)?;
        self.entries_mut().insert(name, entry);
        self.state.mark_dirty();
        Ok(None)
    }

    fn deregister_table(&self, name: &str) -> Result<Option<Arc<dyn TableProvider>>> {
        let removed = self.entries_mut().remove(name);
        if removed.is_some() {
            self.state.mark_dirty();
        }
        Ok(removed.map(|entry| entry.provider()))
    }

    fn table_exist(&self, name: &str) -> bool {
        self.entries().contains_key(name)
    }
}

/// A stored view whose definition could not be planned when its database was
/// attached. It is listed like any other view (with its stored columns) and
/// can be dropped or replaced; scanning it reports why it is unavailable.
#[derive(Debug)]
pub struct UnresolvedView {
    sql: String,
    reason: String,
    schema: SchemaRef,
}

#[async_trait]
impl TableProvider for UnresolvedView {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn schema(&self) -> SchemaRef {
        Arc::clone(&self.schema)
    }

    fn table_type(&self) -> TableType {
        TableType::View
    }

    fn get_table_definition(&self) -> Option<&str> {
        Some(&self.sql)
    }

    async fn scan(
        &self,
        _state: &dyn Session,
        _projection: Option<&Vec<usize>>,
        _filters: &[Expr],
        _limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        plan_err!(
            "This view could not be restored when its database was attached ({}). Create the \
             tables it uses and attach the database again, or replace it with CREATE OR REPLACE VIEW",
            self.reason
        )
    }
}

/// Data of a table, loaded on first use. Always a [`MemTable`] once loaded.
type TableData = Arc<futures::lock::Mutex<Option<Arc<dyn TableProvider>>>>;

/// A table of a persistent database.
///
/// The schema, column defaults and constraints are always available; the
/// rows are read from storage into an inner [`MemTable`] the first time the
/// table is scanned or modified. Mutations are recorded on the
/// [`DatabaseState`] and written by the next flush.
#[derive(Debug)]
pub struct PersistentTable {
    pub id: u64,
    pub state: Arc<DatabaseState>,
    schema: SchemaRef,
    constraints: Constraints,
    column_defaults: HashMap<String, Expr>,
    data: TableData,
    segments: Arc<Mutex<Vec<SegmentManifest>>>,
}

impl PersistentTable {
    /// A new table holding the data of an in-memory table (not written yet).
    pub fn from_memtable(state: Arc<DatabaseState>, memtable: Arc<dyn TableProvider>) -> Self {
        debug_assert!(memtable.as_any().is::<MemTable>());
        let schema = memtable.schema();
        let column_defaults = schema
            .fields()
            .iter()
            .filter_map(|field| {
                memtable
                    .get_column_default(field.name())
                    .map(|expr| (field.name().clone(), expr.clone()))
            })
            .collect();
        Self {
            id: next_table_id(),
            state,
            constraints: memtable.constraints().cloned().unwrap_or_default(),
            column_defaults,
            schema,
            data: Arc::new(futures::lock::Mutex::new(Some(memtable))),
            segments: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// A stored table whose data is loaded from `segments` on first use.
    pub fn stored(
        state: Arc<DatabaseState>,
        schema: SchemaRef,
        constraints: Constraints,
        column_defaults: HashMap<String, Expr>,
        segments: Vec<SegmentManifest>,
    ) -> Self {
        Self {
            id: next_table_id(),
            state,
            schema,
            constraints,
            column_defaults,
            data: Arc::new(futures::lock::Mutex::new(None)),
            segments: Arc::new(Mutex::new(segments)),
        }
    }

    /// Same table (same id, data and segments), new handle. Used when a table
    /// is renamed within its database.
    fn clone_handle(&self) -> Self {
        Self {
            id: self.id,
            state: Arc::clone(&self.state),
            schema: Arc::clone(&self.schema),
            constraints: self.constraints.clone(),
            column_defaults: self.column_defaults.clone(),
            data: Arc::clone(&self.data),
            segments: Arc::clone(&self.segments),
        }
    }

    /// The in-memory table holding the data, loading it from storage first
    /// if needed.
    pub async fn data(&self) -> Result<Arc<dyn TableProvider>> {
        let mut data = self.data.lock().await;
        if let Some(loaded) = data.as_ref() {
            return Ok(Arc::clone(loaded));
        }
        let loaded: Arc<dyn TableProvider> = Arc::new(self.load().await.map_err(|e| {
            datafusion::error::DataFusionError::Execution(format!(
                "Failed to load table from {}: {e}",
                self.state.location
            ))
        })?);
        *data = Some(Arc::clone(&loaded));
        Ok(loaded)
    }

    /// The data if it is already in memory.
    pub fn loaded_data(&self) -> Option<Arc<dyn TableProvider>> {
        self.data.try_lock().and_then(|data| data.clone())
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded_data().is_some()
    }

    async fn load(&self) -> std::result::Result<MemTable, String> {
        let mut batches = Vec::new();
        for segment in self.segments() {
            let path = segment_path(&self.state.root, segment.id);
            let bytes = read_file_detached(self.state.backend_id, path)
                .await?
                .ok_or_else(|| format!("segment {} is missing", segment.id))?;
            let (_, segment_batches) =
                decode_segment(bytes).map_err(|e| format!("segment {}: {e}", segment.id))?;
            for batch in &segment_batches {
                batches.push(align_batch(&self.schema, batch)?);
            }
        }
        Ok(MemTable::try_new(Arc::clone(&self.schema), vec![batches])
            .map_err(|e| e.to_string())?
            .with_constraints(self.constraints.clone())
            .with_column_defaults(self.column_defaults.clone()))
    }

    pub async fn snapshot(&self) -> Result<Vec<RecordBatch>> {
        let data = self.data().await?;
        let mut batches = Vec::new();
        for partition in &memtable(&data)?.batches {
            batches.extend(partition.read().await.iter().cloned());
        }
        Ok(batches)
    }

    pub fn segments(&self) -> Vec<SegmentManifest> {
        self.segments
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn push_segment(&self, segment: SegmentManifest) {
        self.segments
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(segment);
    }

    pub fn replace_segments(&self, segments: Vec<SegmentManifest>) {
        *self.segments.lock().unwrap_or_else(|e| e.into_inner()) = segments;
    }

    /// The manifest entry for this table, or `None` if it has not been
    /// written yet.
    pub fn manifest(&self) -> Option<TableManifest> {
        let segments = self.segments();
        if segments.is_empty() {
            return None;
        }
        let schema = match encode_schema(&self.schema) {
            Ok(schema) => Some(schema),
            Err(e) => {
                console_warn(&format!("CereusDB: {e}"));
                None
            }
        };
        let mut column_defaults = BTreeMap::new();
        for (column, expr) in &self.column_defaults {
            match expr_to_sql(expr) {
                Ok(sql) => {
                    column_defaults.insert(column.clone(), sql.to_string());
                }
                Err(e) => console_warn(&format!(
                    "CereusDB: the default of column '{column}' cannot be stored: {e}"
                )),
            }
        }
        let names = |indices: &[usize]| -> Vec<String> {
            indices
                .iter()
                .filter_map(|index| self.schema.fields().get(*index))
                .map(|field| field.name().clone())
                .collect()
        };
        let constraints = self
            .constraints
            .iter()
            .map(|constraint| match constraint {
                Constraint::PrimaryKey(indices) => ConstraintManifest::PrimaryKey {
                    columns: names(indices),
                },
                Constraint::Unique(indices) => ConstraintManifest::Unique {
                    columns: names(indices),
                },
            })
            .collect();
        Some(TableManifest {
            segments,
            schema,
            column_defaults,
            constraints,
        })
    }
}

/// The [`MemTable`] behind a loaded table's data.
pub fn memtable(data: &Arc<dyn TableProvider>) -> Result<&MemTable> {
    data.as_any().downcast_ref::<MemTable>().ok_or_else(|| {
        datafusion::error::DataFusionError::Internal(
            "persistent table data is not an in-memory table".to_string(),
        )
    })
}

/// Constraints from their manifest form (unknown columns are skipped).
pub fn constraints_from_manifest(
    schema: &SchemaRef,
    constraints: &[ConstraintManifest],
) -> Constraints {
    let indices = |columns: &[String]| -> Option<Vec<usize>> {
        columns
            .iter()
            .map(|column| schema.index_of(column).ok())
            .collect()
    };
    Constraints::new_unverified(
        constraints
            .iter()
            .filter_map(|constraint| match constraint {
                ConstraintManifest::PrimaryKey { columns } => {
                    indices(columns).map(Constraint::PrimaryKey)
                }
                ConstraintManifest::Unique { columns } => indices(columns).map(Constraint::Unique),
            })
            .collect(),
    )
}

#[async_trait]
impl TableProvider for PersistentTable {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn schema(&self) -> SchemaRef {
        Arc::clone(&self.schema)
    }

    fn constraints(&self) -> Option<&Constraints> {
        Some(&self.constraints)
    }

    fn table_type(&self) -> TableType {
        TableType::Base
    }

    fn get_column_default(&self, column: &str) -> Option<&Expr> {
        self.column_defaults.get(column)
    }

    async fn scan(
        &self,
        state: &dyn Session,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        self.data()
            .await?
            .scan(state, projection, filters, limit)
            .await
    }

    async fn insert_into(
        &self,
        _state: &dyn Session,
        input: Arc<dyn ExecutionPlan>,
        insert_op: InsertOp,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        self.schema()
            .logically_equivalent_names_and_types(&input.schema())?;
        let overwrite = match insert_op {
            InsertOp::Append => false,
            InsertOp::Overwrite => true,
            InsertOp::Replace => {
                return not_impl_err!("{insert_op} is not supported for database tables")
            }
        };
        let sink = PersistentSink {
            table_id: self.id,
            state: Arc::clone(&self.state),
            schema: self.schema(),
            data: self.data().await?,
            overwrite,
        };
        Ok(Arc::new(DataSinkExec::new(input, Arc::new(sink), None)))
    }

    async fn delete_from(
        &self,
        state: &dyn Session,
        filters: Vec<Expr>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        let plan = self.data().await?.delete_from(state, filters).await?;
        self.state.record_rewrite(self.id);
        Ok(plan)
    }

    async fn update(
        &self,
        state: &dyn Session,
        assignments: Vec<(String, Expr)>,
        filters: Vec<Expr>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        let plan = self
            .data()
            .await?
            .update(state, assignments, filters)
            .await?;
        self.state.record_rewrite(self.id);
        Ok(plan)
    }
}

/// INSERT sink: appends to the in-memory table and records the new rows.
struct PersistentSink {
    table_id: u64,
    state: Arc<DatabaseState>,
    schema: SchemaRef,
    /// The loaded table data (a [`MemTable`]).
    data: Arc<dyn TableProvider>,
    overwrite: bool,
}

impl fmt::Debug for PersistentSink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PersistentSink")
            .field("table_id", &self.table_id)
            .field("database", &self.state.location)
            .field("overwrite", &self.overwrite)
            .finish()
    }
}

impl DisplayAs for PersistentSink {
    fn fmt_as(&self, _t: DisplayFormatType, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PersistentTable (database={})", self.state.location)
    }
}

#[async_trait]
impl DataSink for PersistentSink {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn schema(&self) -> &SchemaRef {
        &self.schema
    }

    async fn write_all(
        &self,
        mut data: SendableRecordBatchStream,
        _context: &Arc<TaskContext>,
    ) -> Result<u64> {
        let mut batches = Vec::new();
        let mut row_count = 0u64;
        while let Some(batch) = data.next().await.transpose()? {
            if batch.num_rows() == 0 {
                continue;
            }
            row_count += batch.num_rows() as u64;
            batches.push(batch);
        }

        let memtable = memtable(&self.data)?;
        // Inserting invalidates any known sort order, as MemTable does.
        *memtable.sort_order.lock() = vec![];

        if self.overwrite {
            for (index, partition) in memtable.batches.iter().enumerate() {
                let mut guard = partition.write().await;
                *guard = if index == 0 {
                    batches.clone()
                } else {
                    Vec::new()
                };
            }
            self.state.record_rewrite(self.table_id);
        } else if !batches.is_empty() {
            let Some(first) = memtable.batches.first() else {
                return exec_err!("Cannot insert into a table with zero partitions");
            };
            first.write().await.extend(batches.iter().cloned());
            self.state.record_append(self.table_id, batches);
        }

        Ok(row_count)
    }
}
