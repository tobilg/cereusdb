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

//! WASM-compatible object store adapter for CereusDB.
//!
//! Phase 1 approach: uses `InMemory` object store from `object_store` crate.
//! Remote files are pre-fetched entirely into memory, then registered with
//! DataFusion via InMemory store. This avoids implementing a custom HTTP
//! ObjectStore (which requires solving `!Send` issues with `JsFuture`).
//!
//! This is sufficient for files that fit in browser memory. Phase 2 will add
//! a streaming HTTP ObjectStore with Range request support for large files.

use std::sync::Arc;

use bytes::Bytes;
use datafusion::prelude::SessionContext;
use object_store::memory::InMemory;
use object_store::path::Path;
use object_store::{ObjectStore, PutPayload};
use url::Url;

/// Create an InMemory object store with data at the given path.
///
/// Returns the store and the path where data was written.
pub async fn create_memory_store_with_data(
    filename: &str,
    data: Bytes,
) -> Result<(Arc<InMemory>, Path), object_store::Error> {
    let store = InMemory::new();
    let path = Path::from(filename);
    store.put(&path, PutPayload::from(data)).await?;
    Ok((Arc::new(store), path))
}

/// Register an InMemory object store on a DataFusion SessionContext.
///
/// Uses a `memory://` URL scheme so DataFusion can resolve paths.
pub fn register_memory_store(ctx: &SessionContext, store: Arc<InMemory>) {
    let url = Url::parse("memory://").expect("valid memory URL");
    ctx.register_object_store(&url, store);
}

/// Extract the base URL (scheme + host + port) from a full URL.
pub fn base_url_from(url_str: &str) -> Result<Url, String> {
    let url = Url::parse(url_str).map_err(|e| format!("Invalid URL: {e}"))?;
    let base = format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or("localhost"),
        url.port().map(|p| format!(":{p}")).unwrap_or_default()
    );
    Url::parse(&base).map_err(|e| format!("Invalid base URL: {e}"))
}

/// Extract the path portion of a URL (everything after scheme+host+port).
pub fn path_from_url(url_str: &str) -> Result<String, String> {
    let url = Url::parse(url_str).map_err(|e| format!("Invalid URL: {e}"))?;
    Ok(url.path().trim_start_matches('/').to_string())
}
