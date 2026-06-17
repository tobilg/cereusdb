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
//! The browser-backed connector plugs `fetch` into upstream `object_store`
//! HTTP clients. CereusDB supplies the transport, while `object_store` keeps
//! provider-specific signing, listing, retry, and response parsing behavior.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use datafusion::prelude::SessionContext;
use datafusion_catalog_listing::ListingOptions;
use datafusion_datasource_parquet::file_format::ParquetFormat;
use object_store::aws::{AmazonS3Builder, AmazonS3ConfigKey};
use object_store::azure::{AzureConfigKey, MicrosoftAzureBuilder};
use object_store::client::{
    ClientConfigKey, HttpClient, HttpConnector, HttpError, HttpErrorKind, HttpRequest,
    HttpResponse, HttpService,
};
use object_store::gcp::{GoogleCloudStorageBuilder, GoogleConfigKey};
use object_store::http::HttpBuilder;
use object_store::memory::InMemory;
use object_store::path::Path;
use object_store::{ObjectStore, PutPayload};
use serde::Deserialize;
use serde_json::Value;
use url::Url;

const DEFAULT_MAX_CONCURRENCY: usize = 16;
const MAX_CONCURRENCY_LIMIT: usize = 256;

type Result<T> = std::result::Result<T, String>;

/// Top-level browser object store registry configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectStoreRegistryConfig {
    /// Maximum number of concurrent browser fetches issued by this module.
    pub max_concurrency: Option<usize>,
    /// Object stores to register on the DataFusion context.
    #[serde(default)]
    pub stores: Vec<ObjectStoreConfig>,
}

/// Configuration for one object store registration.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectStoreConfig {
    /// User-facing identifier. This is not used by DataFusion lookup, but helps
    /// diagnostics when several stores are registered at once.
    #[serde(default)]
    pub name: Option<String>,
    /// Store provider.
    pub provider: ObjectStoreProvider,
    /// URL prefix registered with DataFusion, for example `https://host`,
    /// `s3://bucket`, `gs://bucket`, or an Azure URL.
    pub url: String,
    /// Provider-specific options using upstream `object_store` key names.
    #[serde(default)]
    pub options: HashMap<String, Value>,
}

/// Supported browser object store providers.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObjectStoreProvider {
    Http,
    S3,
    Gcs,
    Azure,
}

/// Options for registering a listing-backed Parquet table.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterParquetTableOptions {
    /// File extension used for listing discovery. Defaults to `.parquet`.
    pub file_extension: Option<String>,
    /// Optional DataFusion target partition count for the listing table.
    pub target_partitions: Option<usize>,
}

/// Browser connector for upstream object_store HTTP clients.
#[derive(Debug, Clone)]
pub struct BrowserHttpConnector {
    max_concurrency: usize,
}

impl Default for BrowserHttpConnector {
    fn default() -> Self {
        Self {
            max_concurrency: DEFAULT_MAX_CONCURRENCY,
        }
    }
}

impl BrowserHttpConnector {
    /// Create a connector with a bounded browser fetch scheduler.
    pub fn new(max_concurrency: Option<usize>) -> Self {
        let max_concurrency = max_concurrency
            .unwrap_or(DEFAULT_MAX_CONCURRENCY)
            .clamp(1, MAX_CONCURRENCY_LIMIT);
        Self { max_concurrency }
    }
}

impl HttpConnector for BrowserHttpConnector {
    fn connect(&self, _options: &object_store::ClientOptions) -> object_store::Result<HttpClient> {
        #[cfg(target_arch = "wasm32")]
        {
            browser_fetch::set_max_concurrency(self.max_concurrency);
            Ok(HttpClient::new(BrowserHttpService))
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            Err(object_store::Error::NotSupported {
                source: format!(
                    "BrowserHttpConnector is only available on wasm32 targets; configured concurrency was {}",
                    self.max_concurrency
                )
                .into(),
            })
        }
    }
}

#[derive(Debug, Clone, Copy)]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
struct BrowserHttpService;

#[async_trait]
impl HttpService for BrowserHttpService {
    async fn call(&self, req: HttpRequest) -> std::result::Result<HttpResponse, HttpError> {
        #[cfg(target_arch = "wasm32")]
        {
            use futures::channel::oneshot;
            use wasm_bindgen_futures::spawn_local;

            let request = browser_fetch::FetchRequest::try_from(req).await?;
            let (tx, rx) = oneshot::channel();

            spawn_local(async move {
                let _ = tx.send(browser_fetch::execute(request).await);
            });

            rx.await.map_err(|_| {
                HttpError::new(
                    HttpErrorKind::Interrupted,
                    SimpleError("browser fetch task was dropped".to_string()),
                )
            })?
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = req;
            Err(HttpError::new(
                HttpErrorKind::Unknown,
                SimpleError("BrowserHttpService is only available on wasm32 targets".to_string()),
            ))
        }
    }
}

/// Register all object stores from a browser configuration object.
pub fn register_object_stores(
    ctx: &SessionContext,
    config: ObjectStoreRegistryConfig,
) -> Result<()> {
    let connector = BrowserHttpConnector::new(config.max_concurrency);
    for store_config in &config.stores {
        let url = Url::parse(&store_config.url).map_err(|e| {
            format!(
                "invalid object store URL for {}: {e}",
                store_label(store_config)
            )
        })?;
        let store = build_object_store(store_config, connector.clone())?;
        ctx.register_object_store(&url, store);
    }
    Ok(())
}

/// Register a Parquet table backed by a DataFusion listing table.
pub async fn register_parquet_table(
    ctx: &SessionContext,
    table_name: &str,
    table_url: &str,
    options: RegisterParquetTableOptions,
) -> Result<()> {
    let mut listing_options =
        ListingOptions::new(Arc::new(ParquetFormat::default().with_enable_pruning(true)))
            .with_file_extension(
                options
                    .file_extension
                    .unwrap_or_else(|| ".parquet".to_string()),
            );

    if let Some(target_partitions) = options.target_partitions {
        listing_options = listing_options.with_target_partitions(target_partitions);
    }

    ctx.register_listing_table(table_name, table_url, listing_options, None, None)
        .await
        .map_err(|e| format!("failed to register Parquet table {table_name}: {e}"))
}

fn build_object_store(
    config: &ObjectStoreConfig,
    connector: BrowserHttpConnector,
) -> Result<Arc<dyn ObjectStore>> {
    match config.provider {
        ObjectStoreProvider::Http => build_http_store(config, connector),
        ObjectStoreProvider::S3 => build_s3_store(config, connector),
        ObjectStoreProvider::Gcs => build_gcs_store(config, connector),
        ObjectStoreProvider::Azure => build_azure_store(config, connector),
    }
}

fn build_http_store(
    config: &ObjectStoreConfig,
    connector: BrowserHttpConnector,
) -> Result<Arc<dyn ObjectStore>> {
    let mut builder = HttpBuilder::new()
        .with_url(&config.url)
        .with_http_connector(connector);

    for (key, value) in &config.options {
        let key = key
            .parse::<ClientConfigKey>()
            .map_err(|e| format!("invalid HTTP option {key}: {e}"))?;
        builder = builder.with_config(key, config_value(value)?);
    }

    builder
        .build()
        .map(|store| Arc::new(store) as Arc<dyn ObjectStore>)
        .map_err(|e| format!("failed to build HTTP object store {}: {e}", config.url))
}

fn build_s3_store(
    config: &ObjectStoreConfig,
    connector: BrowserHttpConnector,
) -> Result<Arc<dyn ObjectStore>> {
    let mut builder = AmazonS3Builder::new()
        .with_url(&config.url)
        .with_http_connector(connector);

    for (key, value) in &config.options {
        let key = key
            .parse::<AmazonS3ConfigKey>()
            .map_err(|e| format!("invalid S3 option {key}: {e}"))?;
        builder = builder.with_config(key, config_value(value)?);
    }

    builder
        .build()
        .map(|store| Arc::new(store) as Arc<dyn ObjectStore>)
        .map_err(|e| format!("failed to build S3 object store {}: {e}", config.url))
}

fn build_gcs_store(
    config: &ObjectStoreConfig,
    connector: BrowserHttpConnector,
) -> Result<Arc<dyn ObjectStore>> {
    let mut builder = GoogleCloudStorageBuilder::new()
        .with_url(&config.url)
        .with_http_connector(connector);

    for (key, value) in &config.options {
        let key = key
            .parse::<GoogleConfigKey>()
            .map_err(|e| format!("invalid GCS option {key}: {e}"))?;
        builder = builder.with_config(key, config_value(value)?);
    }

    builder
        .build()
        .map(|store| Arc::new(store) as Arc<dyn ObjectStore>)
        .map_err(|e| format!("failed to build GCS object store {}: {e}", config.url))
}

fn build_azure_store(
    config: &ObjectStoreConfig,
    connector: BrowserHttpConnector,
) -> Result<Arc<dyn ObjectStore>> {
    let mut builder = MicrosoftAzureBuilder::new()
        .with_url(&config.url)
        .with_http_connector(connector);

    for (key, value) in &config.options {
        let key = key
            .parse::<AzureConfigKey>()
            .map_err(|e| format!("invalid Azure option {key}: {e}"))?;
        builder = builder.with_config(key, config_value(value)?);
    }

    builder
        .build()
        .map(|store| Arc::new(store) as Arc<dyn ObjectStore>)
        .map_err(|e| format!("failed to build Azure object store {}: {e}", config.url))
}

fn config_value(value: &Value) -> Result<String> {
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::Null | Value::Array(_) | Value::Object(_) => Err(format!(
            "object store option values must be string, number, or boolean, got {value}"
        )),
    }
}

fn store_label(config: &ObjectStoreConfig) -> String {
    config
        .name
        .as_deref()
        .unwrap_or(config.provider.as_str())
        .to_string()
}

impl ObjectStoreProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::S3 => "s3",
            Self::Gcs => "gcs",
            Self::Azure => "azure",
        }
    }
}

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
struct SimpleError(String);

impl fmt::Display for SimpleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SimpleError {}

/// Create an InMemory object store with data at the given path.
///
/// Returns the store and the path where data was written.
pub async fn create_memory_store_with_data(
    filename: &str,
    data: Bytes,
) -> std::result::Result<(Arc<InMemory>, Path), object_store::Error> {
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
pub fn base_url_from(url_str: &str) -> Result<Url> {
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
pub fn path_from_url(url_str: &str) -> Result<String> {
    let url = Url::parse(url_str).map_err(|e| format!("Invalid URL: {e}"))?;
    Ok(url.path().trim_start_matches('/').to_string())
}

#[cfg(target_arch = "wasm32")]
mod browser_fetch {
    use super::*;
    use http::header::{HeaderName, HeaderValue};
    use http::{Response, StatusCode};
    use http_body_util::{BodyExt, Full};
    use object_store::client::HttpResponseBody;
    use serde::Serialize;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(inline_js = r#"
let cereusdbFetchMaxConcurrency = 16;
let cereusdbFetchActive = 0;
const cereusdbFetchQueue = [];

function cereusdbPumpFetchQueue() {
  while (cereusdbFetchActive < cereusdbFetchMaxConcurrency && cereusdbFetchQueue.length > 0) {
    const task = cereusdbFetchQueue.shift();
    cereusdbFetchActive += 1;
    cereusdbExecuteFetch(task.request)
      .then(task.resolve, task.reject)
      .finally(() => {
        cereusdbFetchActive -= 1;
        cereusdbPumpFetchQueue();
      });
  }
}

async function cereusdbExecuteFetch(request) {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    headers.append(name, value);
  }

  const init = {
    method: request.method,
    headers,
  };

  if (request.body !== undefined && request.body !== null) {
    init.body = request.body;
  }

  const response = await fetch(request.url, init);
  const responseHeaders = [];
  response.headers.forEach((value, name) => {
    responseHeaders.push([name, value]);
  });

  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

export function cereusdbSetFetchConcurrency(maxConcurrency) {
  const parsed = Number(maxConcurrency);
  if (Number.isFinite(parsed) && parsed >= 1) {
    cereusdbFetchMaxConcurrency = Math.min(Math.trunc(parsed), 256);
    cereusdbPumpFetchQueue();
  }
}

export function cereusdbFetch(request) {
  return new Promise((resolve, reject) => {
    cereusdbFetchQueue.push({ request, resolve, reject });
    cereusdbPumpFetchQueue();
  });
}
"#)]
    extern "C" {
        #[wasm_bindgen(js_name = cereusdbSetFetchConcurrency)]
        fn js_set_fetch_concurrency(max_concurrency: usize);

        #[wasm_bindgen(catch, js_name = cereusdbFetch)]
        async fn js_fetch(request: JsValue) -> std::result::Result<JsValue, JsValue>;
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FetchRequest {
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Option<Vec<u8>>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FetchResponse {
        status: u16,
        status_text: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl FetchRequest {
        pub async fn try_from(req: HttpRequest) -> std::result::Result<Self, HttpError> {
            let (parts, body) = req.into_parts();
            let body = body.collect().await?.to_bytes().to_vec();

            let headers = parts
                .headers
                .iter()
                .filter_map(|(name, value)| request_header(name, value))
                .collect();

            Ok(Self {
                method: parts.method.to_string(),
                url: parts.uri.to_string(),
                headers,
                body: (!body.is_empty()).then_some(body),
            })
        }
    }

    pub fn set_max_concurrency(max_concurrency: usize) {
        js_set_fetch_concurrency(max_concurrency);
    }

    pub async fn execute(request: FetchRequest) -> std::result::Result<HttpResponse, HttpError> {
        let request = serde_wasm_bindgen::to_value(&request).map_err(decode_error)?;
        let response = js_fetch(request).await.map_err(fetch_error)?;
        let response: FetchResponse =
            serde_wasm_bindgen::from_value(response).map_err(decode_error)?;
        response.into_http_response()
    }

    impl FetchResponse {
        fn into_http_response(self) -> std::result::Result<HttpResponse, HttpError> {
            let mut response = Response::builder()
                .status(StatusCode::from_u16(self.status).map_err(decode_error)?)
                .body(HttpResponseBody::new(
                    Full::new(Bytes::from(self.body)).map_err(|never| match never {}),
                ))
                .map_err(decode_error)?;

            for (name, value) in self.headers {
                let name = HeaderName::from_bytes(name.as_bytes()).map_err(decode_error)?;
                let value = HeaderValue::from_str(&value).map_err(decode_error)?;
                response.headers_mut().append(name, value);
            }

            if response.status().canonical_reason().is_none() && !self.status_text.is_empty() {
                response.extensions_mut().insert(self.status_text);
            }

            Ok(response)
        }
    }

    fn request_header(name: &HeaderName, value: &HeaderValue) -> Option<(String, String)> {
        if is_forbidden_request_header(name.as_str()) {
            return None;
        }

        Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
    }

    fn is_forbidden_request_header(name: &str) -> bool {
        matches!(
            name.to_ascii_lowercase().as_str(),
            "accept-encoding"
                | "connection"
                | "content-length"
                | "cookie"
                | "cookie2"
                | "date"
                | "dnt"
                | "expect"
                | "host"
                | "keep-alive"
                | "origin"
                | "referer"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
                | "user-agent"
                | "via"
        )
    }

    fn fetch_error(value: JsValue) -> HttpError {
        let message = value
            .as_string()
            .or_else(|| {
                js_sys::JSON::stringify(&value)
                    .ok()
                    .and_then(|s| s.as_string())
            })
            .unwrap_or_else(|| "browser fetch failed".to_string());
        HttpError::new(HttpErrorKind::Request, SimpleError(message))
    }

    fn decode_error(error: impl std::error::Error + Send + Sync + 'static) -> HttpError {
        HttpError::new(HttpErrorKind::Decode, error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_values_use_object_store_strings() {
        assert_eq!(config_value(&Value::Bool(true)).unwrap(), "true");
        assert_eq!(config_value(&Value::Number(32.into())).unwrap(), "32");
        assert_eq!(
            config_value(&Value::String("secret".to_string())).unwrap(),
            "secret"
        );
        assert!(config_value(&Value::Null).is_err());
    }

    #[test]
    fn browser_connector_clamps_concurrency() {
        assert_eq!(BrowserHttpConnector::new(Some(0)).max_concurrency, 1);
        assert_eq!(
            BrowserHttpConnector::new(Some(1000)).max_concurrency,
            MAX_CONCURRENCY_LIMIT
        );
    }
}
