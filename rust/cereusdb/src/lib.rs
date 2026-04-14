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
mod io;
#[cfg(feature = "s2")]
mod s2_order;
#[cfg(feature = "random-geometry")]
mod random_geometry;
mod result;

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
        let Some(lay) = layout(size) else { return core::ptr::null_mut() };
        let p = unsafe { alloc(lay) };
        if !p.is_null() {
            sizes().as_mut().unwrap().insert(p as usize, size);
        }
        p
    }

    #[no_mangle]
    pub unsafe extern "C" fn free(ptr: *mut u8) {
        if ptr.is_null() { return; }
        let key = ptr as usize;
        let size = match sizes().as_mut().unwrap().remove(&key) {
            Some(s) => s,
            None => return,
        };
        if let Some(lay) = layout(size) {
            unsafe { dealloc(ptr, lay); }
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn calloc(n: usize, size: usize) -> *mut u8 {
        let total = n.saturating_mul(size);
        let Some(lay) = layout(total) else { return core::ptr::null_mut() };
        let p = unsafe { alloc_zeroed(lay) };
        if !p.is_null() {
            sizes().as_mut().unwrap().insert(p as usize, total);
        }
        p
    }

    #[no_mangle]
    pub unsafe extern "C" fn realloc(ptr: *mut u8, new_size: usize) -> *mut u8 {
        if ptr.is_null() { return unsafe { malloc(new_size) }; }
        let key = ptr as usize;
        let old_size = match sizes().as_mut().unwrap().remove(&key) {
            Some(s) => s,
            None => return core::ptr::null_mut(),
        };
        let Some(old_lay) = layout(old_size) else { return core::ptr::null_mut() };
        let p = unsafe { rs_realloc(ptr, old_lay, new_size.max(1)) };
        if !p.is_null() {
            sizes().as_mut().unwrap().insert(p as usize, new_size);
        }
        p
    }

    #[no_mangle]
    pub unsafe extern "C" fn posix_memalign(memptr: *mut *mut u8, _align: usize, size: usize) -> i32 {
        let p = unsafe { malloc(size) };
        unsafe { *memptr = p; }
        if p.is_null() && size > 0 { 12 } else { 0 }
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
    #[no_mangle] pub unsafe extern "C" fn __libc_malloc(s: usize) -> *mut u8 { unsafe { malloc(s) } }
    #[no_mangle] pub unsafe extern "C" fn __libc_free(p: *mut u8) { unsafe { free(p) } }
    #[no_mangle] pub unsafe extern "C" fn __libc_calloc(n: usize, s: usize) -> *mut u8 { unsafe { calloc(n, s) } }
    #[no_mangle] pub unsafe extern "C" fn emscripten_builtin_malloc(s: usize) -> *mut u8 { unsafe { malloc(s) } }
    #[no_mangle] pub unsafe extern "C" fn emscripten_builtin_free(p: *mut u8) { unsafe { free(p) } }
    #[no_mangle] pub unsafe extern "C" fn emscripten_builtin_memalign(_a: usize, s: usize) -> *mut u8 { unsafe { malloc(s) } }
    #[no_mangle] pub unsafe extern "C" fn emscripten_builtin_malloc_usable_size(p: *mut u8) -> usize { unsafe { malloc_usable_size(p) } }

    // _abort_js / abort: no-op (called during C++ exception cleanup paths)
    #[no_mangle] pub unsafe extern "C" fn _abort_js() {}
    #[no_mangle] pub unsafe extern "C" fn abort() {}
}

use std::sync::Arc;

use arrow_array::RecordBatch;
use datafusion::dataframe::DataFrame;
use datafusion::datasource::MemTable;
use datafusion::logical_expr::{CreateMemoryTable, DdlStatement, LogicalPlan};
use datafusion::prelude::SessionContext;
use wasm_bindgen::prelude::*;

use context::create_sedona_session_context;
use io::{
    fetch_bytes,
    load_geojson_to_memtable,
    load_geotiff_buffer_to_memtable,
    load_parquet_buffer_to_memtable,
    load_raster_buffer_to_memtable,
};
use result::batches_to_ipc_bytes;

/// Main CereusDB instance for browser use.
/// Wraps a DataFusion SessionContext with spatial extensions registered.
#[wasm_bindgen]
pub struct CereusDB {
    ctx: Arc<SessionContext>,
}

#[wasm_bindgen]
impl CereusDB {
    /// Create a new CereusDB instance.
    /// Initializes DataFusion context and registers all spatial functions.
    pub fn create() -> Result<CereusDB, JsValue> {
        console_error_panic_hook::set_once();

        let ctx = create_sedona_session_context()
            .map_err(|e| JsValue::from_str(&format!("Failed to create context: {e}")))?;

        Ok(CereusDB {
            ctx: Arc::new(ctx),
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
            .map_err(|e| JsValue::from_str(&format!("Failed to register parquet: {e}")))
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
            .map_err(|e| JsValue::from_str(&format!("Failed to register parquet: {e}")))
    }

    /// Register a GeoJSON string as a named table.
    pub fn register_geojson(
        &self,
        table_name: &str,
        geojson: &str,
    ) -> Result<(), JsValue> {
        load_geojson_to_memtable(&self.ctx, table_name, geojson)
            .map_err(|e| JsValue::from_str(&format!("Failed to register GeoJSON: {e}")))
    }

    /// Register a GeoTIFF buffer as a single-column raster table.
    /// Requires the full GDAL-enabled build.
    pub fn register_geotiff_buffer(
        &self,
        table_name: &str,
        data: &[u8],
    ) -> Result<(), JsValue> {
        load_geotiff_buffer_to_memtable(&self.ctx, table_name, data)
            .map_err(|e| JsValue::from_str(&format!("Failed to register GeoTIFF: {e}")))
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
            .map_err(|e| JsValue::from_str(&format!("Failed to register raster: {e}")))
    }

    /// Drop a registered table.
    pub fn drop_table(&self, table_name: &str) -> Result<(), JsValue> {
        self.ctx
            .deregister_table(table_name)
            .map_err(|e| JsValue::from_str(&format!("Failed to drop table: {e}")))?;
        Ok(())
    }

    /// List all registered table names.
    pub fn tables(&self) -> Result<JsValue, JsValue> {
        let catalog_names = self.ctx.catalog_names();
        let mut table_names = Vec::new();
        for catalog_name in &catalog_names {
            if let Some(catalog) = self.ctx.catalog(catalog_name) {
                for schema_name in catalog.schema_names() {
                    if let Some(schema) = catalog.schema(&schema_name) {
                        for table_name in schema.table_names() {
                            table_names.push(table_name);
                        }
                    }
                }
            }
        }
        serde_wasm_bindgen::to_value(&table_names)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
    }

    /// Get version information.
    pub fn version(&self) -> String {
        format!("CereusDB {}", env!("CARGO_PKG_VERSION"))
    }
}

impl CereusDB {
    async fn execute_query(&self, query: &str) -> Result<Vec<RecordBatch>, JsValue> {
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
            _ => Ok(false),
        }
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
