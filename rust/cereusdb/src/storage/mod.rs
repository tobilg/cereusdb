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

//! Persistent databases (for example `opfs://mydb`).
//!
//! A persistent database is a DataFusion catalog whose tables are kept in
//! memory and written to a JavaScript storage backend as Arrow IPC segments
//! plus a JSON manifest (see [`manifest`]). Changes are recorded while a
//! statement runs and written by [`StorageManager::flush_all`] before the
//! statement's promise resolves.

pub mod backend;
pub mod catalog;
pub mod info;
pub mod manifest;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, RwLock};

use arrow_array::RecordBatch;
use arrow_schema::SchemaRef;
use datafusion::catalog::{CatalogProviderList, TableProvider};
use datafusion::common::DFSchema;
use datafusion::datasource::{MemTable, ViewTable};
use datafusion::logical_expr::{DdlStatement, LogicalPlan};
use datafusion::prelude::SessionContext;

use backend::StorageBackend;
use catalog::{CereusCatalogList, PendingOp, PersistentCatalog, PersistentTable};
use manifest::{
    decode_schema, decode_segment, encode_segment, manifest_path, segment_id_from_file_name,
    segment_path, segments_dir, DatabaseLocation, Manifest, SegmentManifest, TableManifest,
};

/// Tables with more segments than this are compacted into one segment.
const MAX_SEGMENTS_PER_TABLE: usize = 32;

/// Attached persistent databases by catalog name.
#[derive(Debug, Default)]
pub struct DatabaseRegistry {
    databases: RwLock<BTreeMap<String, Arc<PersistentCatalog>>>,
}

impl DatabaseRegistry {
    pub fn get(&self, name: &str) -> Option<Arc<PersistentCatalog>> {
        self.databases
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(name)
            .cloned()
    }

    pub fn list(&self) -> Vec<Arc<PersistentCatalog>> {
        self.databases
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }

    fn find_by_location(&self, url: &str) -> Option<Arc<PersistentCatalog>> {
        self.list()
            .into_iter()
            .find(|catalog| catalog.state.location == url)
    }

    fn insert(&self, name: String, catalog: Arc<PersistentCatalog>) {
        self.databases
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name, catalog);
    }

    fn remove(&self, name: &str) -> Option<Arc<PersistentCatalog>> {
        self.databases
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMode {
    /// CREATE DATABASE: create a new database; with `if_not_exists`, open an
    /// existing one instead of failing.
    Create { if_not_exists: bool },
    /// ATTACH: open an existing database; with `if_not_exists`, succeed when it
    /// is already attached.
    Attach { if_not_exists: bool },
}

impl OpenMode {
    fn if_not_exists(self) -> bool {
        match self {
            OpenMode::Create { if_not_exists } | OpenMode::Attach { if_not_exists } => {
                if_not_exists
            }
        }
    }
}

/// Target of DROP DATABASE.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatabaseTarget {
    Name(String),
    Location(String),
}

/// Owns the storage backends and the attached persistent databases of one
/// CereusDB instance. Lives on the (single-threaded) JavaScript side of the
/// API, so it can hold JS values.
#[derive(Debug)]
pub struct StorageManager {
    /// Backends by URL scheme, with their id in the global backend registry.
    backends: RefCell<HashMap<String, (StorageBackend, u64)>>,
    registry: Arc<DatabaseRegistry>,
    catalog_list: Arc<CereusCatalogList>,
    default_catalog: String,
    default_schema: String,
    flush_lock: futures::lock::Mutex<()>,
}

impl StorageManager {
    /// Install a catalog list that supports detaching databases and register
    /// the `cereusdb_databases()` table function.
    pub fn install(ctx: &SessionContext) -> Self {
        let state = ctx.state();
        let catalog_list = Arc::new(CereusCatalogList::from_existing(state.catalog_list()));
        ctx.register_catalog_list(Arc::clone(&catalog_list) as _);
        let registry = Arc::new(DatabaseRegistry::default());
        ctx.register_udtf(
            "cereusdb_databases",
            Arc::new(info::DatabasesFunction::new(
                Arc::clone(&catalog_list),
                Arc::clone(&registry),
            )),
        );
        let options = state.config().options();
        Self {
            backends: RefCell::new(HashMap::new()),
            registry,
            catalog_list,
            default_catalog: options.catalog.default_catalog.clone(),
            default_schema: options.catalog.default_schema.clone(),
            flush_lock: futures::lock::Mutex::new(()),
        }
    }

    pub fn registry(&self) -> &Arc<DatabaseRegistry> {
        &self.registry
    }

    pub fn catalog_list(&self) -> &Arc<CereusCatalogList> {
        &self.catalog_list
    }

    pub fn register_backend(&self, scheme: &str, backend: StorageBackend) {
        let id = backend::register_backend(&backend);
        // A replaced backend stays registered: attached databases may still use it.
        self.backends
            .borrow_mut()
            .insert(scheme.to_ascii_lowercase(), (backend, id));
    }

    fn backend(&self, scheme: &str) -> Result<StorageBackend, String> {
        self.backend_with_id(scheme).map(|(backend, _)| backend)
    }

    fn backend_with_id(&self, scheme: &str) -> Result<(StorageBackend, u64), String> {
        self.backends.borrow().get(scheme).cloned().ok_or_else(|| {
            if scheme == "opfs" {
                "No storage backend for 'opfs://': OPFS is not available in this environment. \
                 Pass a backend via CereusDB.create({ storage: { opfs: backend } })"
                    .to_string()
            } else {
                format!("No storage backend registered for '{scheme}://'")
            }
        })
    }

    /// Create or attach a persistent database and register it as a catalog.
    /// Returns the catalog name.
    pub async fn attach(
        &self,
        ctx: &SessionContext,
        location: &str,
        alias: Option<String>,
        mode: OpenMode,
    ) -> Result<String, String> {
        let location = DatabaseLocation::parse(location)?;
        let url = location.url();
        let name = alias.unwrap_or_else(|| location.default_name());
        if name.is_empty() {
            return Err("Database name must not be empty".to_string());
        }

        if let Some(existing) = self.registry.find_by_location(&url) {
            if mode.if_not_exists() && existing.state.name == name {
                return Ok(name);
            }
            return Err(format!(
                "Database {url} is already attached as '{}'",
                existing.state.name
            ));
        }
        if self.catalog_list.catalog(&name).is_some() {
            return Err(match self.registry.get(&name) {
                Some(other) => format!(
                    "Database name '{name}' is already used by {}",
                    other.state.location
                ),
                None => format!("Database name '{name}' is already used by an in-memory database"),
            });
        }

        let (backend, backend_id) = self.backend_with_id(&location.scheme)?;
        let lock_name = format!("cereusdb:{url}");
        backend
            .lock(&lock_name)
            .await
            .map_err(|e| format!("Cannot open database {url}: {e}"))?;

        match self
            .load(ctx, &backend, backend_id, &location, &name, mode)
            .await
        {
            Ok(catalog) => {
                self.registry.insert(name.clone(), catalog);
                Ok(name)
            }
            Err(e) => {
                let _ = backend.unlock(&lock_name).await;
                Err(e)
            }
        }
    }

    async fn load(
        &self,
        ctx: &SessionContext,
        backend: &StorageBackend,
        backend_id: u64,
        location: &DatabaseLocation,
        name: &str,
        mode: OpenMode,
    ) -> Result<Arc<PersistentCatalog>, String> {
        let url = location.url();
        let root = &location.root;
        let manifest = match backend.read(&manifest_path(root)).await? {
            Some(bytes) => {
                if mode
                    == (OpenMode::Create {
                        if_not_exists: false,
                    })
                {
                    return Err(format!(
                        "Database {url} already exists; use ATTACH '{url}' or \
                         CREATE DATABASE IF NOT EXISTS '{url}'"
                    ));
                }
                Manifest::parse(&bytes).map_err(|e| format!("Cannot open database {url}: {e}"))?
            }
            None => match mode {
                OpenMode::Attach { .. } => {
                    return Err(format!(
                        "Database {url} does not exist; use CREATE DATABASE '{url}' to create it"
                    ))
                }
                OpenMode::Create { .. } => {
                    let manifest = Manifest::new_database();
                    backend
                        .write(&manifest_path(root), &manifest.to_bytes()?)
                        .await
                        .map_err(|e| format!("Cannot create database {url}: {e}"))?;
                    manifest
                }
            },
        };

        let state = Arc::new(catalog::DatabaseState::new(
            name.to_string(),
            location.scheme.clone(),
            root.clone(),
            backend_id,
            &manifest,
        ));
        let catalog = Arc::new(PersistentCatalog::new(Arc::clone(&state)));
        for (schema_name, schema_manifest) in &manifest.schemas {
            let schema = catalog.insert_loaded_schema(schema_name);
            for (table_name, table_manifest) in &schema_manifest.tables {
                let table = open_table(ctx, backend, &state, table_manifest)
                    .await
                    .map_err(|e| {
                        format!("Cannot open database {url}: table {schema_name}.{table_name}: {e}")
                    })?;
                schema.insert_loaded_table(table_name, Arc::new(table));
            }
        }

        self.catalog_list
            .register_catalog(name.to_string(), Arc::clone(&catalog) as _);
        restore_views(ctx, &catalog, &manifest).await;
        remove_orphaned_segments(backend, root, &manifest).await;
        Ok(catalog)
    }

    /// Write pending changes, then remove the database's catalog.
    pub async fn detach(
        &self,
        ctx: &SessionContext,
        name: &str,
        if_exists: bool,
    ) -> Result<(), String> {
        let Some(catalog) = self.registry.get(name) else {
            if if_exists {
                return Ok(());
            }
            if self.catalog_list.catalog(name).is_some() {
                return Err(format!(
                    "Database '{name}' is an in-memory database; use DROP DATABASE to remove it"
                ));
            }
            return Err(format!("Database '{name}' is not attached"));
        };

        self.flush_all()
            .await
            .map_err(|e| format!("Cannot detach database '{name}': {e}"))?;

        self.registry.remove(name);
        self.catalog_list.deregister_catalog(name);
        self.reset_default_catalog_if(ctx, name);
        if let Ok(backend) = self.backend(&catalog.state.scheme) {
            let _ = backend.unlock(&catalog.state.lock_name()).await;
        }
        Ok(())
    }

    /// DROP DATABASE: detach (if attached) and delete persistent storage, or
    /// remove an in-memory catalog.
    pub async fn drop_database(
        &self,
        ctx: &SessionContext,
        target: DatabaseTarget,
        if_exists: bool,
    ) -> Result<(), String> {
        let location = match target {
            DatabaseTarget::Name(name) => {
                if let Some(catalog) = self.registry.get(&name) {
                    let location = DatabaseLocation::parse(&catalog.state.location)?;
                    self.detach(ctx, &name, false).await?;
                    location
                } else if self.catalog_list.catalog(&name).is_some() {
                    if name == self.current_default_catalog(ctx) {
                        return Err(format!(
                            "Cannot drop database '{name}' because it is the current default \
                             database; USE another database first"
                        ));
                    }
                    self.catalog_list.deregister_catalog(&name);
                    return Ok(());
                } else if if_exists {
                    return Ok(());
                } else {
                    return Err(format!("Database '{name}' does not exist"));
                }
            }
            DatabaseTarget::Location(url) => {
                let location = DatabaseLocation::parse(&url)?;
                if let Some(catalog) = self.registry.find_by_location(&location.url()) {
                    let name = catalog.state.name.clone();
                    self.detach(ctx, &name, false).await?;
                } else {
                    let backend = self.backend(&location.scheme)?;
                    if backend
                        .read(&manifest_path(&location.root))
                        .await?
                        .is_none()
                    {
                        if if_exists {
                            return Ok(());
                        }
                        return Err(format!("Database {} does not exist", location.url()));
                    }
                }
                location
            }
        };

        let backend = self.backend(&location.scheme)?;
        let lock_name = format!("cereusdb:{}", location.url());
        backend
            .lock(&lock_name)
            .await
            .map_err(|e| format!("Cannot drop database {}: {e}", location.url()))?;
        let result = backend.remove(&location.root).await;
        let _ = backend.unlock(&lock_name).await;
        result.map_err(|e| format!("Cannot drop database {}: {e}", location.url()))
    }

    /// Rewrite every table of a database into a single segment.
    pub async fn compact(&self, name: &str) -> Result<(), String> {
        let catalog = self
            .registry
            .get(name)
            .ok_or_else(|| format!("Database '{name}' is not attached"))?;
        for table_id in catalog.tables_by_id().into_keys() {
            catalog.state.record_rewrite(table_id);
        }
        self.flush_all().await
    }

    /// Write all pending changes of all attached databases.
    pub async fn flush_all(&self) -> Result<(), String> {
        let _guard = self.flush_lock.lock().await;
        let mut errors = Vec::new();
        for catalog in self.registry.list() {
            if let Err(e) = self.flush_database(&catalog).await {
                errors.push(format!("{}: {e}", catalog.state.location));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    async fn flush_database(&self, catalog: &PersistentCatalog) -> Result<(), String> {
        let state = &catalog.state;
        let Some(work) = state.take_work() else {
            return Ok(());
        };
        let backend = self.backend(&state.scheme)?;
        let tables = catalog.tables_by_id();

        let mut failure: Option<String> = None;
        for (table_id, op) in work.ops {
            let Some(table) = tables.get(&table_id) else {
                // Dropped or replaced before the flush.
                continue;
            };
            if failure.is_some() {
                state.record_rewrite(table_id);
                continue;
            }
            let result = match op {
                PendingOp::Append(batches) => write_append(&backend, table, batches).await,
                PendingOp::Rewrite => write_rewrite(&backend, table).await,
            };
            if let Err(e) = result {
                // A rewrite captures everything that is in memory.
                state.record_rewrite(table_id);
                failure = Some(e);
            }
        }

        if failure.is_none() {
            for table in tables.values() {
                // Tables that were never loaded have not changed since attach.
                if table.is_loaded() && table.segments().len() > MAX_SEGMENTS_PER_TABLE {
                    if let Err(e) = write_rewrite(&backend, table).await {
                        failure = Some(e);
                        break;
                    }
                }
            }
        }

        if let Some(e) = failure {
            state.mark_dirty();
            return Err(e);
        }

        let manifest = catalog.build_manifest();
        let written = match manifest.to_bytes() {
            Ok(bytes) => backend.write(&manifest_path(&state.root), &bytes).await,
            Err(e) => Err(e),
        };
        if let Err(e) = written {
            state.mark_dirty();
            return Err(e);
        }

        let current: HashSet<u64> = manifest.segment_ids().collect();
        for id in state.committed_segments().difference(&current) {
            let _ = backend.remove(&segment_path(&state.root, *id)).await;
        }
        state.set_committed_segments(current);
        Ok(())
    }

    fn current_default_catalog(&self, ctx: &SessionContext) -> String {
        ctx.state()
            .config()
            .options()
            .catalog
            .default_catalog
            .clone()
    }

    fn reset_default_catalog_if(&self, ctx: &SessionContext, name: &str) {
        if self.current_default_catalog(ctx) != name {
            return;
        }
        let state = ctx.state_ref();
        let mut state = state.write();
        let options = state.config_mut().options_mut();
        options.catalog.default_catalog = self.default_catalog.clone();
        options.catalog.default_schema = self.default_schema.clone();
    }

    /// Storage directories known to a backend (for listing databases that are
    /// not attached).
    pub async fn list_locations(&self, scheme: &str) -> Result<Vec<String>, String> {
        let backend = self.backend(scheme)?;
        let mut locations = Vec::new();
        for entry in backend.list("").await? {
            let Some(root) = entry.strip_suffix('/') else {
                continue;
            };
            if backend.read(&manifest_path(root)).await?.is_some() {
                locations.push(format!("{scheme}://{root}"));
            }
        }
        Ok(locations)
    }

    pub fn has_backend(&self, scheme: &str) -> bool {
        self.backends.borrow().contains_key(scheme)
    }
}

/// Create a table from its manifest entry. Its data is loaded on first use;
/// only entries written before the schema was stored in the manifest are
/// read right away (to learn the schema).
async fn open_table(
    ctx: &SessionContext,
    backend: &StorageBackend,
    state: &Arc<catalog::DatabaseState>,
    table: &TableManifest,
) -> Result<PersistentTable, String> {
    let (schema, eager_batches) = match &table.schema {
        Some(schema) => (decode_schema(schema)?, None),
        None => {
            let (schema, batches) = read_segments(backend, &state.root, &table.segments).await?;
            (schema, Some(batches))
        }
    };

    let constraints = catalog::constraints_from_manifest(&schema, &table.constraints);
    let df_schema = DFSchema::try_from(schema.as_ref().clone()).map_err(|e| e.to_string())?;
    let mut column_defaults = HashMap::new();
    for (column, sql) in &table.column_defaults {
        match ctx.parse_sql_expr(sql, &df_schema) {
            Ok(expr) => {
                column_defaults.insert(column.clone(), expr);
            }
            Err(e) => info::console_warn(&format!(
                "CereusDB: ignoring stored default of column '{column}' ({sql}): {e}"
            )),
        }
    }

    let Some(batches) = eager_batches else {
        return Ok(PersistentTable::stored(
            Arc::clone(state),
            schema,
            constraints,
            column_defaults,
            table.segments.clone(),
        ));
    };
    let memtable = MemTable::try_new(schema, vec![batches])
        .map_err(|e| e.to_string())?
        .with_constraints(constraints)
        .with_column_defaults(column_defaults);
    let opened = PersistentTable::from_memtable(Arc::clone(state), Arc::new(memtable));
    opened.replace_segments(table.segments.clone());
    Ok(opened)
}

async fn read_segments(
    backend: &StorageBackend,
    root: &str,
    segments: &[SegmentManifest],
) -> Result<(SchemaRef, Vec<RecordBatch>), String> {
    let mut schema = None;
    let mut batches = Vec::new();
    for segment in segments {
        let bytes = backend
            .read(&segment_path(root, segment.id))
            .await?
            .ok_or_else(|| format!("segment {} is missing", segment.id))?;
        let (segment_schema, segment_batches) =
            decode_segment(bytes).map_err(|e| format!("segment {}: {e}", segment.id))?;
        schema.get_or_insert(segment_schema);
        batches.extend(segment_batches);
    }
    let schema = schema.ok_or_else(|| "table has no segments".to_string())?;
    Ok((schema, batches))
}

async fn write_append(
    backend: &StorageBackend,
    table: &PersistentTable,
    batches: Vec<arrow_array::RecordBatch>,
) -> Result<(), String> {
    let rows: usize = batches.iter().map(|batch| batch.num_rows()).sum();
    if rows == 0 {
        return Ok(());
    }
    let bytes = encode_segment(&table.schema(), &batches)?;
    let id = table.state.allocate_segment_id();
    backend
        .write(&segment_path(&table.state.root, id), &bytes)
        .await?;
    table.push_segment(SegmentManifest {
        id,
        rows: rows as u64,
    });
    Ok(())
}

async fn write_rewrite(backend: &StorageBackend, table: &PersistentTable) -> Result<(), String> {
    let batches = table.snapshot().await.map_err(|e| e.to_string())?;
    // The snapshot includes rows of any append recorded so far.
    table.state.discard_pending_append(table.id);
    let rows: usize = batches.iter().map(|batch| batch.num_rows()).sum();
    let bytes = encode_segment(&table.schema(), &batches)?;
    let id = table.state.allocate_segment_id();
    backend
        .write(&segment_path(&table.state.root, id), &bytes)
        .await?;
    table.replace_segments(vec![SegmentManifest {
        id,
        rows: rows as u64,
    }]);
    Ok(())
}

/// Plan stored view definitions. Views may depend on each other, so retry
/// until no more views can be planned; the rest are registered as
/// [`catalog::UnresolvedView`]s.
async fn restore_views(ctx: &SessionContext, catalog: &PersistentCatalog, manifest: &Manifest) {
    let mut pending: Vec<(String, String, manifest::ViewManifest)> = manifest
        .schemas
        .iter()
        .flat_map(|(schema_name, schema)| {
            schema.views.iter().map(move |(view_name, view)| {
                (schema_name.clone(), view_name.clone(), view.clone())
            })
        })
        .collect();
    let schema_named = |name: &str| {
        catalog
            .persistent_schemas()
            .into_iter()
            .find(|(schema_name, _)| schema_name == name)
            .map(|(_, schema)| schema)
    };

    loop {
        let mut unresolved = Vec::new();
        let before = pending.len();
        for (schema_name, view_name, view) in pending {
            match plan_view(ctx, &catalog.state.name, &schema_name, &view.sql).await {
                Ok(planned) => {
                    if let Some(schema) = schema_named(&schema_name) {
                        schema.insert_loaded_view(&view_name, Arc::new(planned), view.sql);
                    }
                }
                Err(e) => unresolved.push((schema_name, view_name, view, e)),
            }
        }
        if unresolved.is_empty() || unresolved.len() == before {
            for (schema_name, view_name, view, reason) in unresolved {
                info::console_warn(&format!(
                    "CereusDB: view {schema_name}.{view_name} in {} could not be restored: {reason}",
                    catalog.state.location
                ));
                if let Some(schema) = schema_named(&schema_name) {
                    let columns = view.schema.as_deref().and_then(|s| decode_schema(s).ok());
                    schema.insert_unresolved_view(&view_name, view.sql, columns, reason);
                }
            }
            return;
        }
        pending = unresolved
            .into_iter()
            .map(|(schema_name, view_name, view, _)| (schema_name, view_name, view))
            .collect();
    }
}

async fn plan_view(
    ctx: &SessionContext,
    catalog_name: &str,
    schema_name: &str,
    sql: &str,
) -> Result<ViewTable, String> {
    let mut state = ctx.state();
    {
        let options = state.config_mut().options_mut();
        options.catalog.default_catalog = catalog_name.to_string();
        options.catalog.default_schema = schema_name.to_string();
    }
    match state
        .create_logical_plan(sql)
        .await
        .map_err(|e| e.to_string())?
    {
        LogicalPlan::Ddl(DdlStatement::CreateView(create)) => Ok(ViewTable::new(
            Arc::unwrap_or_clone(create.input),
            Some(sql.to_string()),
        )),
        _ => Err("stored definition is not a CREATE VIEW statement".to_string()),
    }
}

/// Remove segment files that no manifest references (left behind when a write
/// failed or the page closed before the manifest was written).
async fn remove_orphaned_segments(backend: &StorageBackend, root: &str, manifest: &Manifest) {
    let referenced: HashSet<u64> = manifest.segment_ids().collect();
    let Ok(entries) = backend.list(&segments_dir(root)).await else {
        return;
    };
    for entry in entries {
        if let Some(id) = segment_id_from_file_name(&entry) {
            if !referenced.contains(&id) {
                let _ = backend.remove(&segment_path(root, id)).await;
            }
        }
    }
}
