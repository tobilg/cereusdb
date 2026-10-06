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

//! Bridge to storage backends implemented in JavaScript.
//!
//! The TypeScript wrapper supplies an object per URL scheme (for example an
//! OPFS-backed one for `opfs://`). All paths are relative to the backend root
//! and use `/` as separator. Required methods:
//!
//! - `readFile(path) -> Promise<Uint8Array | null>`
//! - `writeFile(path, data) -> Promise<void>` (must replace the file atomically)
//! - `remove(path) -> Promise<void>` (file or directory, recursive, missing is ok)
//! - `list(path) -> Promise<string[]>` (entry names; directories end with `/`)
//!
//! Optional methods: `lock(name)` / `unlock(name)` for cross-tab exclusivity.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use js_sys::{Array, Function, Promise, Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

const REQUIRED_METHODS: &[&str] = &["readFile", "writeFile", "remove", "list"];

#[derive(Clone, Debug)]
pub struct StorageBackend {
    inner: JsValue,
}

impl StorageBackend {
    pub fn from_js(value: JsValue) -> Result<Self, String> {
        if !value.is_object() {
            return Err("storage backend must be an object".to_string());
        }
        for method in REQUIRED_METHODS {
            if method_of(&value, method).is_none() {
                return Err(format!("storage backend is missing method '{method}'"));
            }
        }
        Ok(Self { inner: value })
    }

    pub async fn read(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        let value = self.call("readFile", &[JsValue::from_str(path)]).await?;
        if value.is_null() || value.is_undefined() {
            return Ok(None);
        }
        Ok(Some(Uint8Array::new(&value).to_vec()))
    }

    pub async fn write(&self, path: &str, data: &[u8]) -> Result<(), String> {
        let bytes = Uint8Array::from(data);
        self.call("writeFile", &[JsValue::from_str(path), bytes.into()])
            .await
            .map(|_| ())
    }

    pub async fn remove(&self, path: &str) -> Result<(), String> {
        self.call("remove", &[JsValue::from_str(path)])
            .await
            .map(|_| ())
    }

    pub async fn list(&self, path: &str) -> Result<Vec<String>, String> {
        let value = self.call("list", &[JsValue::from_str(path)]).await?;
        if value.is_null() || value.is_undefined() {
            return Ok(Vec::new());
        }
        if !Array::is_array(&value) {
            return Err(format!("list('{path}') did not return an array"));
        }
        Ok(Array::from(&value)
            .iter()
            .filter_map(|entry| entry.as_string())
            .collect())
    }

    pub async fn lock(&self, name: &str) -> Result<(), String> {
        if method_of(&self.inner, "lock").is_none() {
            return Ok(());
        }
        self.call("lock", &[JsValue::from_str(name)])
            .await
            .map(|_| ())
    }

    pub async fn unlock(&self, name: &str) -> Result<(), String> {
        if method_of(&self.inner, "unlock").is_none() {
            return Ok(());
        }
        self.call("unlock", &[JsValue::from_str(name)])
            .await
            .map(|_| ())
    }

    async fn call(&self, method: &str, args: &[JsValue]) -> Result<JsValue, String> {
        let function = method_of(&self.inner, method)
            .ok_or_else(|| format!("storage backend is missing method '{method}'"))?;
        let js_args = args.iter().collect::<Array>();
        let returned = function
            .apply(&self.inner, &js_args)
            .map_err(|e| format!("{method} failed: {}", js_error_message(&e)))?;
        JsFuture::from(Promise::resolve(&returned))
            .await
            .map_err(|e| format!("{method} failed: {}", js_error_message(&e)))
    }
}

fn method_of(target: &JsValue, name: &str) -> Option<Function> {
    Reflect::get(target, &JsValue::from_str(name))
        .ok()
        .and_then(|value| value.dyn_into::<Function>().ok())
}

pub fn js_error_message(value: &JsValue) -> String {
    if let Some(message) = Reflect::get(value, &JsValue::from_str("message"))
        .ok()
        .and_then(|m| m.as_string())
    {
        return message;
    }
    value.as_string().unwrap_or_else(|| format!("{value:?}"))
}

static NEXT_BACKEND_ID: AtomicU64 = AtomicU64::new(1);

thread_local! {
    /// Backends by id, so code that must be `Send` (DataFusion table
    /// providers) can refer to a backend without holding a JS value.
    static BACKENDS: RefCell<HashMap<u64, StorageBackend>> = RefCell::new(HashMap::new());
}

/// Make `backend` reachable through [`read_file_detached`]; returns its id.
pub fn register_backend(backend: &StorageBackend) -> u64 {
    let id = NEXT_BACKEND_ID.fetch_add(1, Ordering::Relaxed);
    BACKENDS.with(|backends| backends.borrow_mut().insert(id, backend.clone()));
    id
}

/// Read a file from a registered backend. Unlike [`StorageBackend::read`],
/// the returned future is `Send`: the JS call runs as a local task and the
/// result comes back over a channel (the browser runtime is single-threaded).
pub async fn read_file_detached(backend_id: u64, path: String) -> Result<Option<Vec<u8>>, String> {
    let (tx, rx) = futures::channel::oneshot::channel();
    wasm_bindgen_futures::spawn_local(async move {
        let backend = BACKENDS.with(|backends| backends.borrow().get(&backend_id).cloned());
        let result = match backend {
            Some(backend) => backend.read(&path).await,
            None => Err("storage backend is no longer registered".to_string()),
        };
        let _ = tx.send(result);
    });
    rx.await
        .map_err(|_| "storage read was cancelled".to_string())?
}
