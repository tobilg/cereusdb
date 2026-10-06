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

//! CereusDB WebAssembly entry point.
//!
//! This crate provides the `#[wasm_bindgen]` public API for running
//! CereusDB in the browser. It wraps a DataFusion SessionContext with
//! spatial extensions (ST_* functions) registered.

mod context;
mod export;
mod io;
#[cfg(feature = "random-geometry")]
mod random_geometry;
mod result;
mod statements;
mod storage;

// wasm-bindgen 0.2.114 generates Wasm catch wrappers whenever the final module
// contains EH instructions. Our linked Emscripten-built C++ libraries can
// introduce those instructions even when Rust itself is not providing the
// runtime export, so keep an explicit termination flag exported for the
// wrapper transform to target.
#[cfg(target_arch = "wasm32")]
#[allow(non_upper_case_globals)]
#[no_mangle]
pub static mut __instance_terminated: u32 = 0;

// Export C-compatible malloc/free/calloc/realloc that delegate to Rust's
// default allocator (dlmalloc on wasm32-unknown-unknown). This is needed
// because Emscripten-compiled C/C++ code (GEOS, PROJ) calls malloc/free,
// and Rust's wasm32 allocator only exports __rust_alloc/__rust_dealloc.
//
// No #[global_allocator] is set — Rust uses its default dlmalloc which
// calls memory.grow directly (not emscripten_resize_heap), avoiding
// any dependency on the JS env shim for memory management.
#[cfg(all(
    target_arch = "wasm32",
    any(feature = "geos", feature = "proj", feature = "gdal")
))]
mod c_malloc {
    use std::alloc::{alloc, alloc_zeroed, dealloc, realloc as rs_realloc, Layout};
    use std::collections::HashMap;
    use std::sync::Mutex;

    const ALIGN: usize = 16;

    // Track allocation sizes in a map instead of inline headers.
    // Headers can be corrupted if C++ code frees a non-heap pointer
    // (e.g., during exception unwind with -fwasm-exceptions).
    static SIZES: Mutex<Option<HashMap<usize, usize>>> = Mutex::new(None);

    fn sizes() -> std::sync::MutexGuard<'static, Option<HashMap<usize, usize>>> {
        let mut guard = SIZES.lock().unwrap();
        if guard.is_none() {
            *guard = Some(HashMap::with_capacity(1024));
        }
        guard
    }

    fn layout(size: usize) -> Option<Layout> {
        Layout::from_size_align(size.max(1), ALIGN).ok()
    }

    #[no_mangle]
    pub unsafe extern "C" fn malloc(size: usize) -> *mut u8 {
        let Some(lay) = layout(size) else {
            return core::ptr::null_mut();
        };
        let p = unsafe { alloc(lay) };
        if !p.is_null() {
            sizes().as_mut().unwrap().insert(p as usize, size);
        }
        p
    }

    #[no_mangle]
    pub unsafe extern "C" fn free(ptr: *mut u8) {
        if ptr.is_null() {
            return;
        }
        let key = ptr as usize;
        let size = match sizes().as_mut().unwrap().remove(&key) {
            Some(s) => s,
            None => return,
        };
        if let Some(lay) = layout(size) {
            unsafe {
                dealloc(ptr, lay);
            }
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn calloc(n: usize, size: usize) -> *mut u8 {
        let total = n.saturating_mul(size);
        let Some(lay) = layout(total) else {
            return core::ptr::null_mut();
        };
        let p = unsafe { alloc_zeroed(lay) };
        if !p.is_null() {
            sizes().as_mut().unwrap().insert(p as usize, total);
        }
        p
    }

    #[no_mangle]
    pub unsafe extern "C" fn realloc(ptr: *mut u8, new_size: usize) -> *mut u8 {
        if ptr.is_null() {
            return unsafe { malloc(new_size) };
        }
        let key = ptr as usize;
        let old_size = match sizes().as_mut().unwrap().remove(&key) {
            Some(s) => s,
            None => return core::ptr::null_mut(),
        };
        let Some(old_lay) = layout(old_size) else {
            return core::ptr::null_mut();
        };
        let p = unsafe { rs_realloc(ptr, old_lay, new_size.max(1)) };
        if !p.is_null() {
            sizes().as_mut().unwrap().insert(p as usize, new_size);
        }
        p
    }

    #[no_mangle]
    pub unsafe extern "C" fn posix_memalign(
        memptr: *mut *mut u8,
        _align: usize,
        size: usize,
    ) -> i32 {
        let p = unsafe { malloc(size) };
        unsafe {
            *memptr = p;
        }
        if p.is_null() && size > 0 {
            12
        } else {
            0
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn malloc_usable_size(ptr: *mut u8) -> usize {
        if ptr.is_null() {
            return 0;
        }

        sizes()
            .as_ref()
            .and_then(|entries| entries.get(&(ptr as usize)).copied())
            .unwrap_or(0)
    }

    // Emscripten internal aliases
    #[no_mangle]
    pub unsafe extern "C" fn __libc_malloc(s: usize) -> *mut u8 {
        unsafe { malloc(s) }
    }
    #[no_mangle]
    pub unsafe extern "C" fn __libc_free(p: *mut u8) {
        unsafe { free(p) }
    }
    #[no_mangle]
    pub unsafe extern "C" fn __libc_calloc(n: usize, s: usize) -> *mut u8 {
        unsafe { calloc(n, s) }
    }
    #[no_mangle]
    pub unsafe extern "C" fn emscripten_builtin_malloc(s: usize) -> *mut u8 {
        unsafe { malloc(s) }
    }
    #[no_mangle]
    pub unsafe extern "C" fn emscripten_builtin_free(p: *mut u8) {
        unsafe { free(p) }
    }
    #[no_mangle]
    pub unsafe extern "C" fn emscripten_builtin_memalign(_a: usize, s: usize) -> *mut u8 {
        unsafe { malloc(s) }
    }
    #[no_mangle]
    pub unsafe extern "C" fn emscripten_builtin_malloc_usable_size(p: *mut u8) -> usize {
        unsafe { malloc_usable_size(p) }
    }

    // _abort_js / abort: no-op (called during C++ exception cleanup paths)
    #[no_mangle]
    pub unsafe extern "C" fn _abort_js() {}
    #[no_mangle]
    pub unsafe extern "C" fn abort() {}
}

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use arrow_array::RecordBatch;
use datafusion::catalog::MemorySchemaProvider;
use datafusion::dataframe::DataFrame;
use datafusion::datasource::MemTable;
use datafusion::logical_expr::{CreateCatalog, CreateMemoryTable, DdlStatement, LogicalPlan};
use datafusion::prelude::SessionContext;
use wasm_bindgen::prelude::*;

use context::create_sedona_session_context;
use io::{
    fetch_bytes, load_geojson_to_memtable, load_geotiff_buffer_to_memtable,
    load_parquet_buffer_to_memtable, load_raster_buffer_to_memtable,
};
use result::batches_to_ipc_bytes;
use statements::DatabaseStatement;
use storage::backend::StorageBackend;
use storage::{DatabaseTarget, OpenMode, StorageManager};

/// Main CereusDB instance for browser use.
/// Wraps a DataFusion SessionContext with spatial extensions registered.
#[wasm_bindgen]
pub struct CereusDB {
    ctx: Arc<SessionContext>,
    storage: Rc<StorageManager>,
    /// JS function `(filename, bytes, mimeType)` that receives files written
    /// by `COPY ... TO`.
    export_handler: RefCell<Option<js_sys::Function>>,
}

fn js_err(message: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&message.to_string())
}

#[wasm_bindgen]
impl CereusDB {
    /// Create a new CereusDB instance.
    /// Initializes DataFusion context and registers all spatial functions.
    pub fn create() -> Result<CereusDB, JsValue> {
        console_error_panic_hook::set_once();

        let ctx = create_sedona_session_context()
            .map_err(|e| JsValue::from_str(&format!("Failed to create context: {e}")))?;
        let storage = Rc::new(StorageManager::install(&ctx));

        Ok(CereusDB {
            ctx: Arc::new(ctx),
            storage,
            export_handler: RefCell::new(None),
        })
    }

    /// Execute a SQL query.
    /// Returns results as Arrow IPC bytes (Uint8Array).
    /// The caller can decode this with the apache-arrow JS library.
    pub async fn sql(&self, query: &str) -> Result<js_sys::Uint8Array, JsValue> {
        let batches = self.execute_query(query).await?;

        let ipc_bytes = batches_to_ipc_bytes(&batches)
            .map_err(|e| JsValue::from_str(&format!("IPC serialization error: {e}")))?;

        let uint8_array = js_sys::Uint8Array::new_with_length(ipc_bytes.len() as u32);
        uint8_array.copy_from(&ipc_bytes);
        Ok(uint8_array)
    }

    /// Execute a SQL query and return results as a JSON string.
    /// Convenience method for simple use cases.
    pub async fn sql_json(&self, query: &str) -> Result<String, JsValue> {
        let batches = self.execute_query(query).await?;

        result::batches_to_json(&batches)
            .map_err(|e| JsValue::from_str(&format!("JSON serialization error: {e}")))
    }

    /// Register a Uint8Array containing Parquet data as a named table.
    /// Use for files obtained via the browser File API.
    pub async fn register_parquet_buffer(
        &self,
        table_name: &str,
        data: &[u8],
    ) -> Result<(), JsValue> {
        load_parquet_buffer_to_memtable(&self.ctx, table_name, data)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to register parquet: {e}")))?;
        self.flush_storage().await
    }

    /// Register a remote Parquet file URL as a named table.
    /// Pre-fetches the entire file via HTTP, then loads into memory.
    /// The server must support CORS.
    pub async fn register_remote_parquet(
        &self,
        table_name: &str,
        url: &str,
    ) -> Result<(), JsValue> {
        let bytes = fetch_bytes(url)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to fetch {url}: {e}")))?;

        load_parquet_buffer_to_memtable(&self.ctx, table_name, &bytes)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to register parquet: {e}")))?;
        self.flush_storage().await
    }

    /// Register browser-backed object stores for ranged/listing reads.
    pub fn register_object_stores(&self, config: JsValue) -> Result<(), JsValue> {
        self.register_object_stores_impl(config)
    }

    /// Register a remote Parquet object or prefix as a DataFusion listing table.
    pub async fn register_parquet_table(
        &self,
        table_name: &str,
        table_url: &str,
        options: JsValue,
    ) -> Result<(), JsValue> {
        self.register_parquet_table_impl(table_name, table_url, options)
            .await
    }

    /// Register a GeoJSON string as a named table.
    pub fn register_geojson(&self, table_name: &str, geojson: &str) -> Result<(), JsValue> {
        load_geojson_to_memtable(&self.ctx, table_name, geojson)
            .map_err(|e| JsValue::from_str(&format!("Failed to register GeoJSON: {e}")))?;
        self.schedule_flush();
        Ok(())
    }

    /// Register a GeoTIFF buffer as a single-column raster table.
    /// Requires the full GDAL-enabled build.
    pub fn register_geotiff_buffer(&self, table_name: &str, data: &[u8]) -> Result<(), JsValue> {
        load_geotiff_buffer_to_memtable(&self.ctx, table_name, data)
            .map_err(|e| JsValue::from_str(&format!("Failed to register GeoTIFF: {e}")))?;
        self.schedule_flush();
        Ok(())
    }

    /// Register a raster buffer as a single-column raster table.
    /// Requires the full GDAL-enabled build.
    pub fn register_raster_buffer(
        &self,
        table_name: &str,
        format: &str,
        data: &[u8],
    ) -> Result<(), JsValue> {
        load_raster_buffer_to_memtable(&self.ctx, table_name, format, data)
            .map_err(|e| JsValue::from_str(&format!("Failed to register raster: {e}")))?;
        self.schedule_flush();
        Ok(())
    }

    /// Drop a registered table. Call `flush()` to write the change when the
    /// table belongs to a persistent database.
    pub fn drop_table(&self, table_name: &str) -> Result<(), JsValue> {
        self.ctx
            .deregister_table(table_name)
            .map_err(|e| JsValue::from_str(&format!("Failed to drop table: {e}")))?;
        Ok(())
    }

    /// Register the storage backend used for database locations with the given
    /// URL scheme (for example `opfs`).
    pub fn register_storage_backend(&self, scheme: &str, backend: JsValue) -> Result<(), JsValue> {
        let backend = StorageBackend::from_js(backend).map_err(js_err)?;
        self.storage.register_backend(scheme, backend);
        Ok(())
    }

    /// Create (`create = true`) or attach a persistent database. Returns the
    /// database (catalog) name.
    pub async fn attach_database(
        &self,
        location: &str,
        name: Option<String>,
        create: bool,
        if_not_exists: bool,
    ) -> Result<String, JsValue> {
        let mode = if create {
            OpenMode::Create { if_not_exists }
        } else {
            OpenMode::Attach { if_not_exists }
        };
        self.storage
            .attach(&self.ctx, location, name, mode)
            .await
            .map_err(js_err)
    }

    /// Detach a persistent database after writing pending changes.
    pub async fn detach_database(&self, name: &str, if_exists: bool) -> Result<(), JsValue> {
        self.storage
            .detach(&self.ctx, name, if_exists)
            .await
            .map_err(js_err)
    }

    /// Drop a database by name or location URL. Persistent databases are
    /// deleted from storage.
    pub async fn drop_database(&self, target: &str, if_exists: bool) -> Result<(), JsValue> {
        let target = if target.contains(":/") {
            DatabaseTarget::Location(target.to_string())
        } else {
            DatabaseTarget::Name(target.to_string())
        };
        self.storage
            .drop_database(&self.ctx, target, if_exists)
            .await
            .map_err(js_err)
    }

    /// Rewrite every table of a persistent database into a single segment.
    pub async fn compact_database(&self, name: &str) -> Result<(), JsValue> {
        self.storage.compact(name).await.map_err(js_err)
    }

    /// Write all pending changes of attached persistent databases.
    pub async fn flush(&self) -> Result<(), JsValue> {
        self.flush_storage().await
    }

    /// Database locations stored in the backend for `scheme`, attached or not.
    pub async fn list_database_locations(&self, scheme: &str) -> Result<JsValue, JsValue> {
        if !self.storage.has_backend(scheme) {
            return Ok(js_sys::Array::new().into());
        }
        let locations = self.storage.list_locations(scheme).await.map_err(js_err)?;
        Ok(locations
            .into_iter()
            .map(|location| JsValue::from_str(&location))
            .collect::<js_sys::Array>()
            .into())
    }

    /// Describe all databases, schemas, tables and views as a JSON string.
    pub async fn catalog_json(&self) -> Result<String, JsValue> {
        let databases =
            storage::info::describe_catalog(self.storage.catalog_list(), self.storage.registry())
                .await
                .map_err(js_err)?;
        serde_json::to_string(&databases).map_err(js_err)
    }

    /// Run a query and encode the result as GeoParquet. `options` may set
    /// `compression` and `rowGroupSize`.
    pub async fn export_geoparquet(
        &self,
        query: &str,
        options: JsValue,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let options = if options.is_undefined() || options.is_null() {
            export::GeoParquetOptions::default()
        } else {
            serde_wasm_bindgen::from_value(options)
                .map_err(|e| js_err(format!("Invalid GeoParquet options: {e}")))?
        };
        let (bytes, _) = export::export_geoparquet(&self.ctx, query, options)
            .await
            .map_err(|e| js_err(format!("GeoParquet export failed: {e}")))?;
        Ok(js_sys::Uint8Array::from(bytes.as_slice()))
    }

    /// Set the function `(filename, bytes, mimeType)` that receives files
    /// written by `COPY ... TO`. `null` removes it.
    pub fn register_export_handler(&self, handler: JsValue) -> Result<(), JsValue> {
        let handler = if handler.is_null() || handler.is_undefined() {
            None
        } else {
            Some(
                handler
                    .dyn_into::<js_sys::Function>()
                    .map_err(|_| js_err("export handler must be a function"))?,
            )
        };
        *self.export_handler.borrow_mut() = handler;
        Ok(())
    }

    /// Insert Arrow IPC data (stream or file format) into a table, matching
    /// columns by name. Returns the number of inserted rows.
    pub async fn insert_arrow(&self, table_name: &str, data: &[u8]) -> Result<f64, JsValue> {
        let inserted = statements::insert_arrow(&self.ctx, table_name, data).await;
        let flushed = self.flush_storage().await;
        let rows =
            inserted.map_err(|e| js_err(format!("Failed to insert into {table_name}: {e}")))?;
        flushed?;
        Ok(rows as f64)
    }

    /// List all registered table names.
    pub fn tables(&self) -> Result<JsValue, JsValue> {
        self.table_names(false)
    }

    /// List all tables and views as `catalog.schema.table`.
    pub fn qualified_tables(&self) -> Result<JsValue, JsValue> {
        self.table_names(true)
    }

    /// Get version information.
    ///
    /// Release builds set `CEREUSDB_VERSION` to the full npm version, including
    /// prerelease suffixes; other builds fall back to the crate version.
    pub fn version(&self) -> String {
        let version = match option_env!("CEREUSDB_VERSION") {
            Some(version) if !version.is_empty() => version,
            _ => env!("CARGO_PKG_VERSION"),
        };
        format!("CereusDB {version}")
    }
}

impl CereusDB {
    fn table_names(&self, qualified: bool) -> Result<JsValue, JsValue> {
        let mut table_names = Vec::new();
        for catalog_name in self.ctx.catalog_names() {
            let Some(catalog) = self.ctx.catalog(&catalog_name) else {
                continue;
            };
            for schema_name in catalog.schema_names() {
                let Some(schema) = catalog.schema(&schema_name) else {
                    continue;
                };
                for table_name in schema.table_names() {
                    table_names.push(if qualified {
                        format!("{catalog_name}.{schema_name}.{table_name}")
                    } else {
                        table_name
                    });
                }
            }
        }
        serde_wasm_bindgen::to_value(&table_names)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
    }

    #[cfg(feature = "browser-object-store")]
    fn register_object_stores_impl(&self, config: JsValue) -> Result<(), JsValue> {
        let config = serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("Invalid object store config: {e}")))?;
        cereusdb_object_store::register_object_stores(&self.ctx, config)
            .map_err(|e| JsValue::from_str(&format!("Failed to register object stores: {e}")))
    }

    #[cfg(not(feature = "browser-object-store"))]
    fn register_object_stores_impl(&self, _config: JsValue) -> Result<(), JsValue> {
        Err(JsValue::from_str(
            "Browser object stores are not enabled in this CereusDB build",
        ))
    }

    #[cfg(feature = "browser-object-store")]
    async fn register_parquet_table_impl(
        &self,
        table_name: &str,
        table_url: &str,
        options: JsValue,
    ) -> Result<(), JsValue> {
        let options = if options.is_undefined() || options.is_null() {
            cereusdb_object_store::RegisterParquetTableOptions::default()
        } else {
            serde_wasm_bindgen::from_value(options)
                .map_err(|e| JsValue::from_str(&format!("Invalid Parquet table options: {e}")))?
        };

        cereusdb_object_store::register_parquet_table(&self.ctx, table_name, table_url, options)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to register Parquet table: {e}")))
    }

    #[cfg(not(feature = "browser-object-store"))]
    async fn register_parquet_table_impl(
        &self,
        _table_name: &str,
        _table_url: &str,
        _options: JsValue,
    ) -> Result<(), JsValue> {
        Err(JsValue::from_str(
            "Browser object stores are not enabled in this CereusDB build",
        ))
    }

    /// Write pending changes of persistent databases.
    async fn flush_storage(&self) -> Result<(), JsValue> {
        self.storage.flush_all().await.map_err(|e| {
            js_err(format!(
                "Storage error: changes were applied in memory but could not be persisted \
                 (they will be retried with the next statement): {e}"
            ))
        })
    }

    /// Flush from a synchronous method; errors are reported on the console and
    /// the changes are retried by the next flush.
    fn schedule_flush(&self) {
        let storage = Rc::clone(&self.storage);
        wasm_bindgen_futures::spawn_local(async move {
            if let Err(e) = storage.flush_all().await {
                storage::info::console_warn(&format!("CereusDB storage error: {e}"));
            }
        });
    }

    async fn execute_query(&self, query: &str) -> Result<Vec<RecordBatch>, JsValue> {
        let result = self.execute_statement(query).await;
        let flushed = self.flush_storage().await;
        let batches = result?;
        flushed?;
        Ok(batches)
    }

    async fn execute_statement(&self, query: &str) -> Result<Vec<RecordBatch>, JsValue> {
        if let Some(statement) = statements::parse_database_statement(query)
            .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?
        {
            self.execute_database_statement(statement)
                .await
                .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?;
            return Ok(Vec::new());
        }

        if let Some(copy) = export::parse_copy(&self.ctx, query)
            .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?
        {
            let rows = self
                .execute_copy(copy)
                .await
                .map_err(|e| JsValue::from_str(&format!("COPY failed: {e}")))?;
            return Ok(vec![result::count_batch(rows as u64)]);
        }

        if statements::try_execute_alter_table(&self.ctx, query)
            .await
            .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?
        {
            return Ok(Vec::new());
        }

        if self.try_execute_browser_safe_ddl(query).await? {
            return Ok(Vec::new());
        }

        let df = self
            .ctx
            .sql(query)
            .await
            .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?;

        df.collect()
            .await
            .map_err(|e| JsValue::from_str(&format!("Collect error: {e}")))
    }

    async fn execute_database_statement(&self, statement: DatabaseStatement) -> Result<(), String> {
        match statement {
            DatabaseStatement::Create {
                location,
                name,
                if_not_exists,
            } => self
                .storage
                .attach(
                    &self.ctx,
                    &location,
                    name,
                    OpenMode::Create { if_not_exists },
                )
                .await
                .map(|_| ()),
            DatabaseStatement::Attach {
                location,
                alias,
                if_not_exists,
            } => self
                .storage
                .attach(
                    &self.ctx,
                    &location,
                    alias,
                    OpenMode::Attach { if_not_exists },
                )
                .await
                .map(|_| ()),
            DatabaseStatement::Detach { name, if_exists } => {
                self.storage.detach(&self.ctx, &name, if_exists).await
            }
            DatabaseStatement::Drop { target, if_exists } => {
                self.storage
                    .drop_database(&self.ctx, target, if_exists)
                    .await
            }
            DatabaseStatement::Use { parts } => self.use_database(&parts),
        }
    }

    /// Export the rows of a `COPY` statement and pass the file to the export
    /// handler. Returns the number of exported rows.
    async fn execute_copy(&self, copy: export::CopyRequest) -> Result<usize, String> {
        let handler = self.export_handler.borrow().clone().ok_or(
            "no export handler: in browsers COPY downloads the file; elsewhere pass \
             CereusDB.create({ onExport })",
        )?;
        let (bytes, rows) = export::export_geoparquet(&self.ctx, &copy.query, copy.options).await?;
        let returned = handler
            .call3(
                &JsValue::NULL,
                &JsValue::from_str(&copy.filename),
                &js_sys::Uint8Array::from(bytes.as_slice()),
                &JsValue::from_str(export::PARQUET_MIME_TYPE),
            )
            .map_err(|e| storage::backend::js_error_message(&e))?;
        wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&returned))
            .await
            .map_err(|e| storage::backend::js_error_message(&e))?;
        Ok(rows)
    }

    /// `USE database`, `USE database.schema` or `USE schema` (in the current
    /// database).
    fn use_database(&self, parts: &[String]) -> Result<(), String> {
        let state = self.ctx.state();
        let current_catalog = state.config().options().catalog.default_catalog.clone();
        let (catalog_name, schema_name) = match parts {
            [catalog, schema] => (catalog.clone(), Some(schema.clone())),
            [name] if self.ctx.catalog(name).is_some() => (name.clone(), None),
            [name] => (current_catalog, Some(name.clone())),
            _ => return Err("Invalid USE statement".to_string()),
        };
        let catalog = self
            .ctx
            .catalog(&catalog_name)
            .ok_or_else(|| format!("Database '{catalog_name}' does not exist"))?;
        let schema_name = match schema_name {
            Some(schema) => {
                if catalog.schema(&schema).is_none() {
                    return Err(format!("Schema '{catalog_name}.{schema}' does not exist"));
                }
                schema
            }
            None => {
                let names = catalog.schema_names();
                if names.iter().any(|name| name == "public") {
                    "public".to_string()
                } else {
                    names.into_iter().next().ok_or_else(|| {
                        format!("Database '{catalog_name}' has no schemas; create one first")
                    })?
                }
            }
        };

        let state = self.ctx.state_ref();
        let mut state = state.write();
        let options = state.config_mut().options_mut();
        options.catalog.default_catalog = catalog_name;
        options.catalog.default_schema = schema_name;
        Ok(())
    }

    async fn try_execute_browser_safe_ddl(&self, query: &str) -> Result<bool, JsValue> {
        let normalized = query.trim_start().to_ascii_uppercase();
        if !normalized.starts_with("CREATE") {
            return Ok(false);
        }

        let plan = self
            .ctx
            .state()
            .create_logical_plan(query)
            .await
            .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?;

        // DataFusion's CreateMemoryTable executor uses Tokio JoinSet internals
        // that are not available inside the browser runtime.
        match plan {
            LogicalPlan::Ddl(DdlStatement::CreateMemoryTable(cmd)) => {
                self.execute_create_memory_table(cmd).await?;
                Ok(true)
            }
            LogicalPlan::Ddl(DdlStatement::CreateCatalog(cmd)) => {
                self.execute_create_catalog(cmd).await?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// In-memory `CREATE DATABASE`: DataFusion creates an empty catalog; add
    /// the default schema so it matches persistent databases (and `USE` works).
    async fn execute_create_catalog(&self, cmd: CreateCatalog) -> Result<(), JsValue> {
        let name = cmd.catalog_name.clone();
        let existed = self.ctx.catalog(&name).is_some();
        self.ctx
            .execute_logical_plan(LogicalPlan::Ddl(DdlStatement::CreateCatalog(cmd)))
            .await
            .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?;
        if existed {
            return Ok(());
        }
        if let Some(catalog) = self.ctx.catalog(&name) {
            if catalog.schema_names().is_empty() {
                let default_schema = self
                    .ctx
                    .state()
                    .config()
                    .options()
                    .catalog
                    .default_schema
                    .clone();
                catalog
                    .register_schema(&default_schema, Arc::new(MemorySchemaProvider::new()))
                    .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?;
            }
        }
        Ok(())
    }

    async fn execute_create_memory_table(&self, cmd: CreateMemoryTable) -> Result<(), JsValue> {
        let CreateMemoryTable {
            name,
            constraints,
            input,
            if_not_exists,
            or_replace,
            column_defaults,
            temporary,
        } = cmd;

        if temporary {
            return Err(JsValue::from_str(
                "SQL error: Temporary tables not supported",
            ));
        }

        let exists = self
            .ctx
            .table_exist(name.clone())
            .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?;

        match (if_not_exists, or_replace, exists) {
            (true, false, true) => Ok(()),
            (false, true, true) => {
                self.ctx
                    .deregister_table(name.clone())
                    .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?;
                self.register_memory_table(
                    name,
                    Arc::unwrap_or_clone(input),
                    constraints,
                    column_defaults,
                )
                .await
            }
            (true, true, true) => Err(JsValue::from_str(
                "SQL error: 'IF NOT EXISTS' cannot coexist with 'REPLACE'",
            )),
            (_, _, false) => {
                self.register_memory_table(
                    name,
                    Arc::unwrap_or_clone(input),
                    constraints,
                    column_defaults,
                )
                .await
            }
            (false, false, true) => Err(JsValue::from_str(&format!(
                "SQL error: Table '{name}' already exists"
            ))),
        }
    }

    async fn register_memory_table(
        &self,
        name: datafusion_common::TableReference,
        input: LogicalPlan,
        constraints: datafusion_common::Constraints,
        column_defaults: Vec<(String, datafusion::logical_expr::Expr)>,
    ) -> Result<(), JsValue> {
        let schema = Arc::clone(input.schema().inner());
        let batches = DataFrame::new(self.ctx.state(), input)
            .collect()
            .await
            .map_err(|e| JsValue::from_str(&format!("Collect error: {e}")))?;
        let partitions = if batches.is_empty() {
            vec![vec![]]
        } else {
            vec![batches]
        };
        let table = MemTable::try_new(schema, partitions)
            .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?
            .with_constraints(constraints)
            .with_column_defaults(column_defaults.into_iter().collect());

        self.ctx
            .register_table(name, Arc::new(table))
            .map_err(|e| JsValue::from_str(&format!("SQL error: {e}")))?;
        Ok(())
    }
}
