# Product Requirements Document: CereusDB

## Document metadata

- **Project**: SedonaDB WebAssembly Build (`cereusdb`)
- **Repository**: https://github.com/apache/sedona-db (fork)
- **Upstream version**: 0.4.0 (branch `main`)
- **Target**: Browser-based geospatial analytical database via WebAssembly
- **Status**: Draft

---

## 1. Objective

Build a WebAssembly target for Apache SedonaDB that runs in modern browsers, providing near-complete feature parity with the native build. The WASM build must support:

- Full SQL query engine (DataFusion-based)
- Spatial functions (vector and raster) via pure Rust and GEOS
- CRS reprojection via PROJ
- Multi-format data ingestion via GDAL (vector subset)
- GPU-accelerated spatial operations via WebGPU (replacing CUDA)
- Remote GeoParquet reading over HTTP
- Local file ingestion via browser File API

The deliverable is an NPM-publishable package (`@cereusdb/cereusdb`) with TypeScript bindings.

---

## 2. Repository structure changes

All new code lives alongside the existing workspace. The upstream `Cargo.toml` workspace `members` list is extended. No existing crate source files are modified — all WASM adaptations use feature flags and new crates.

### 2.1 New directories and files to create

```
sedona-db/
├── rust/
│   ├── cereusdb/                    # NEW: WASM entry point crate
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # wasm_bindgen public API
│   │       ├── context.rs              # SedonaDB session setup for WASM
│   │       ├── io.rs                   # File upload + remote registration
│   │       └── result.rs               # Arrow IPC serialization for JS
│   ├── sedona-gpu/                     # NEW: WebGPU spatial acceleration
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # GPU context init, fallback logic
│   │       ├── context.rs              # wgpu device/queue/adapter management
│   │       ├── buffers.rs              # Arrow RecordBatch ↔ GPU buffer conversion
│   │       ├── kernels/
│   │       │   ├── mod.rs
│   │       │   ├── spatial_join.rs     # GPU spatial join dispatch
│   │       │   ├── distance.rs         # GPU distance matrix dispatch
│   │       │   ├── point_in_polygon.rs # GPU bulk PIP dispatch
│   │       │   └── raster_algebra.rs   # GPU raster ops dispatch
│   │       └── shaders/
│   │           ├── spatial_join.wgsl
│   │           ├── distance_matrix.wgsl
│   │           ├── point_in_polygon.wgsl
│   │           └── raster_algebra.wgsl
│   └── cereusdb-object-store/       # NEW: thin adapter crate
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs                  # Bridges object-store-wasm into sedona-datasource
├── wasm/                               # NEW: WASM build infrastructure
│   ├── build.sh                        # Master build script
│   ├── Makefile                        # Convenience targets
│   ├── emscripten/
│   │   ├── build-geos.sh
│   │   ├── build-proj.sh
│   │   ├── build-gdal.sh
│   │   ├── build-tg.sh
│   │   └── toolchain.cmake            # Emscripten CMake toolchain overrides
│   ├── patches/                        # Any source patches needed for WASM compat
│   │   └── README.md
│   ├── js/
│   │   ├── package.json               # NPM package definition
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts               # Public TypeScript API
│   │   │   ├── worker.ts              # Web Worker wrapper
│   │   │   └── types.ts               # TypeScript type definitions
│   │   └── examples/
│   │       ├── basic-query.html
│   │       ├── remote-parquet.html
│   │       ├── file-upload.html
│   │       └── webgpu-spatial-join.html
│   └── tests/
│       ├── integration/
│       │   ├── test_spatial_functions.js
│       │   ├── test_remote_parquet.js
│       │   ├── test_file_upload.js
│       │   └── test_webgpu.js
│       └── wasm-test-runner.js
├── third_party/                        # NEW: Vendored C/C++ sources
│   ├── geos/                           # git submodule: libgeos/geos
│   ├── proj/                           # git submodule: OSGeo/PROJ
│   ├── proj-data/                      # Subset or full PROJ CRS database
│   ├── gdal/                           # git submodule: OSGeo/gdal
│   ├── sqlite/                         # Amalgamation for GeoPackage support
│   ├── zlib/                           # For GDAL compressed formats
│   ├── expat/                          # For GDAL KML/GML parsing
│   └── tg/                             # git submodule: tidwall/tg
└── Cargo.toml                          # MODIFIED: add feature flags + new members
```

### 2.2 Files to modify

These existing files need targeted modifications (feature flags only — no logic changes to existing code paths):

| File | Modification |
|---|---|
| `Cargo.toml` (workspace root) | Add `cereusdb`, `sedona-gpu`, `cereusdb-object-store` to `members`. Add `[features]` section. |
| `.gitmodules` | Add submodules for `third_party/geos`, `third_party/proj`, `third_party/gdal`, `third_party/tg`. |
| `rust/sedona/Cargo.toml` | Add `wasm` feature flag that excludes `mimalloc`, `sysinfo`, `dirs`, `tempfile`, `libloading`, `adbc` deps. |
| `rust/sedona-datasource/Cargo.toml` | Add `wasm` feature that swaps `object_store` for `cereusdb-object-store`. |
| Any crate using `tokio::spawn_blocking` | Gate behind `#[cfg(not(target_arch = "wasm32"))]` with async alternative for WASM. |

---

## 3. Crate specifications

### 3.1 `cereusdb` (entry point)

**Purpose**: The WASM-facing public API. This is the crate that `wasm-pack build` produces.

**File**: `rust/cereusdb/Cargo.toml`

```toml
[package]
name = "cereusdb"
version = "0.4.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
wasm-bindgen-futures = "0.4"
js-sys = "0.3"
web-sys = { version = "0.3", features = ["console"] }
wasm-logger = "0.2"
getrandom = { version = "0.2", features = ["js"] }
serde = { version = "1", features = ["derive"] }
serde-wasm-bindgen = "0.6"

# SedonaDB core (with wasm feature)
sedona = { path = "../sedona", features = ["wasm"] }
sedona-functions = { path = "../sedona-functions" }
sedona-expr = { path = "../sedona-expr" }
sedona-schema = { path = "../sedona-schema" }
sedona-geoparquet = { path = "../sedona-geoparquet" }
sedona-datasource = { path = "../sedona-datasource", features = ["wasm"] }
sedona-spatial-join = { path = "../sedona-spatial-join" }
sedona-geo = { path = "../sedona-geo" }
sedona-geometry = { path = "../sedona-geometry" }
cereusdb-object-store = { path = "../cereusdb-object-store" }

# Optional: heavy C deps
sedona-geos = { path = "../../c/sedona-geos", optional = true }
sedona-proj = { path = "../../c/sedona-proj", optional = true }
sedona-gdal = { path = "../../c/sedona-gdal", optional = true, default-features = false }

# Optional: GPU
sedona-gpu = { path = "../sedona-gpu", optional = true }

# DataFusion (WASM-compatible subset)
datafusion = { version = "51.0.0", default-features = false }

# Arrow for IPC serialization
arrow = { version = "57.0.0", features = ["ipc"] }
arrow-ipc = { version = "57.0.0" }

[features]
default = ["geos", "proj"]
geos = ["sedona-geos"]
proj = ["sedona-proj"]
gdal = ["sedona-gdal"]
gpu = ["sedona-gpu"]
full = ["geos", "proj", "gdal", "gpu"]
```

**File**: `rust/cereusdb/src/lib.rs`

Implement the following public API:

```rust
use wasm_bindgen::prelude::*;

/// Main SedonaDB instance for browser use.
/// Wraps a DataFusion SessionContext with spatial extensions registered.
#[wasm_bindgen]
pub struct SedonaDB {
    // Internal: Arc<SessionContext> with sedona UDFs registered
}

#[wasm_bindgen]
impl SedonaDB {
    /// Create a new SedonaDB instance.
    /// Initializes DataFusion context, registers all spatial functions,
    /// and optionally initializes WebGPU if available.
    #[wasm_bindgen(constructor)]
    pub async fn new() -> Result<SedonaDB, JsValue>;

    /// Execute a SQL query.
    /// Returns results as Arrow IPC bytes (Uint8Array).
    /// The caller can decode this with the apache-arrow JS library.
    pub async fn sql(&self, query: &str) -> Result<js_sys::Uint8Array, JsValue>;

    /// Execute a SQL query and return results as a JSON string.
    /// Convenience method for simple use cases.
    pub async fn sql_json(&self, query: &str) -> Result<String, JsValue>;

    /// Register a Uint8Array containing Parquet data as a named table.
    /// Use for files obtained via the browser File API.
    pub async fn register_parquet_buffer(
        &mut self,
        table_name: &str,
        data: &[u8],
    ) -> Result<(), JsValue>;

    /// Register a remote Parquet file URL as a named table.
    /// Reads via HTTP range requests. The server must support CORS and Range headers.
    pub async fn register_remote_parquet(
        &mut self,
        table_name: &str,
        url: &str,
    ) -> Result<(), JsValue>;

    /// Register a remote Parquet file URL with options (e.g., S3 credentials).
    pub async fn register_remote_parquet_with_options(
        &mut self,
        table_name: &str,
        url: &str,
        options: JsValue, // { region?: string, access_key_id?: string, ... }
    ) -> Result<(), JsValue>;

    /// Register a GeoJSON string as a named table.
    pub fn register_geojson(
        &mut self,
        table_name: &str,
        geojson: &str,
    ) -> Result<(), JsValue>;

    /// Register a WKT string collection as a named table.
    pub fn register_wkt(
        &mut self,
        table_name: &str,
        wkt_strings: Vec<String>,
    ) -> Result<(), JsValue>;

    /// Register arbitrary file bytes using GDAL for format detection.
    /// Only available when compiled with the `gdal` feature.
    /// Supports: Shapefile, GeoPackage, KML, GML, FlatGeobuf, CSV, etc.
    #[cfg(feature = "gdal")]
    pub async fn register_file_buffer(
        &mut self,
        table_name: &str,
        filename: &str, // Used for format detection by extension
        data: &[u8],
    ) -> Result<(), JsValue>;

    /// Drop a registered table.
    pub fn drop_table(&mut self, table_name: &str) -> Result<(), JsValue>;

    /// List all registered table names.
    pub fn tables(&self) -> Vec<String>;

    /// Get the schema of a registered table as JSON.
    pub fn table_schema(&self, table_name: &str) -> Result<String, JsValue>;

    /// Check whether WebGPU is available for GPU acceleration.
    pub async fn has_webgpu(&self) -> bool;

    /// Get version information.
    pub fn version(&self) -> String;
}
```

**Implementation notes for `lib.rs`**:

1. In the constructor (`new()`):
   - Call `wasm_logger::init(wasm_logger::Config::default())` for browser console logging.
   - Create a `SessionContext` with `SessionConfig::new().with_information_schema(true)`.
   - Register all sedona spatial UDFs from `sedona-functions` via `sedona::register_functions(&ctx)`.
   - Register the `cereusdb-object-store` HTTP backend for remote URL access.
   - If `gpu` feature is enabled, attempt `sedona_gpu::GpuContext::try_init().await` and store the handle.

2. In `sql()`:
   - Execute `ctx.sql(query).await` to get a `DataFrame`.
   - Collect into `Vec<RecordBatch>` via `df.collect().await`.
   - Serialize to Arrow IPC bytes using `arrow_ipc::writer::StreamWriter`.
   - Return as `js_sys::Uint8Array`.

3. In `register_parquet_buffer()`:
   - Wrap the `&[u8]` in a `bytes::Bytes`.
   - Create an in-memory `ObjectStore` backed by the bytes.
   - Register via `ctx.register_parquet()` or create a `MemTable` from the decoded Parquet.

4. In `register_remote_parquet()`:
   - Create an HTTP-backed `ObjectStore` via `object-store-wasm` pointing to the URL.
   - Register via `ctx.register_object_store()` for the URL scheme.
   - Create an external table via `ctx.register_listing_table()`.

---

### 3.2 `sedona-gpu` (WebGPU acceleration)

**Purpose**: GPU-accelerated spatial operations using `wgpu`, targeting both native (Vulkan/Metal/DX12) and browser (WebGPU).

**File**: `rust/sedona-gpu/Cargo.toml`

```toml
[package]
name = "sedona-gpu"
version = "0.4.0"
edition = "2021"

[dependencies]
wgpu = { version = "24", features = ["fragile-send-sync-non-atomic-wasm"] }
arrow = { version = "57.0.0" }
arrow-array = { version = "57.0.0" }
arrow-buffer = { version = "57.0.0" }
bytemuck = { version = "1.25", features = ["derive"] }
log = "0.4"
thiserror = "2"
futures = "0.3"
geo-types = "0.7.17"

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "0.2"
wasm-bindgen-futures = "0.4"
web-sys = { version = "0.3", features = [
    "Gpu", "GpuAdapter", "GpuDevice", "GpuQueue",
    "GpuBuffer", "GpuBufferDescriptor", "GpuBufferUsage",
    "GpuComputePipeline", "GpuComputePassEncoder",
    "GpuCommandEncoder", "GpuShaderModule",
    "GpuBindGroup", "GpuBindGroupLayout",
    "Navigator",
] }
```

**File**: `rust/sedona-gpu/src/lib.rs`

```rust
pub struct GpuContext {
    device: wgpu::Device,
    queue: wgpu::Queue,
    // Pre-compiled compute pipelines for each kernel
    spatial_join_pipeline: Option<wgpu::ComputePipeline>,
    distance_pipeline: Option<wgpu::ComputePipeline>,
    pip_pipeline: Option<wgpu::ComputePipeline>,
    raster_pipeline: Option<wgpu::ComputePipeline>,
}

impl GpuContext {
    /// Attempt to initialize WebGPU/Vulkan/Metal.
    /// Returns None if no GPU adapter is available.
    pub async fn try_init() -> Option<Self>;

    /// Check if GPU is available without initializing.
    pub async fn is_available() -> bool;
}
```

**File**: `rust/sedona-gpu/src/context.rs`

Implement GPU device initialization:

```rust
pub async fn try_init() -> Option<GpuContext> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });

    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })
        .await?;

    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("SedonaDB GPU"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
        }, None)
        .await
        .ok()?;

    // Compile shader modules and create compute pipelines
    // ...

    Some(GpuContext { device, queue, /* pipelines */ })
}
```

**File**: `rust/sedona-gpu/src/buffers.rs`

Implement Arrow RecordBatch ↔ GPU storage buffer conversion:

```rust
/// Upload coordinate arrays from an Arrow Float64Array to a GPU storage buffer.
pub fn upload_coordinates(
    device: &wgpu::Device,
    x: &Float64Array,
    y: &Float64Array,
) -> wgpu::Buffer;

/// Download GPU result buffer back to an Arrow array.
pub fn download_results<T: ArrowPrimitiveType>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    buffer: &wgpu::Buffer,
    len: usize,
) -> PrimitiveArray<T>;
```

**File**: `rust/sedona-gpu/src/shaders/point_in_polygon.wgsl`

Example WGSL compute shader for point-in-polygon testing:

```wgsl
struct Point {
    x: f64,
    y: f64,
};

@group(0) @binding(0) var<storage, read> points: array<Point>;
@group(0) @binding(1) var<storage, read> polygon_vertices: array<Point>;
@group(0) @binding(2) var<storage, read> polygon_ring_offsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> results: array<u32>;

@group(0) @binding(4) var<uniform> params: Params;

struct Params {
    num_points: u32,
    num_vertices: u32,
    num_rings: u32,
};

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.num_points) { return; }

    let point = points[idx];
    var inside = false;

    // Ray casting algorithm
    let ring_start = polygon_ring_offsets[0];
    let ring_end = polygon_ring_offsets[1];

    var j = ring_end - 1u;
    for (var i = ring_start; i < ring_end; i = i + 1u) {
        let vi = polygon_vertices[i];
        let vj = polygon_vertices[j];

        if ((vi.y > point.y) != (vj.y > point.y)) {
            let intersect_x = (vj.x - vi.x) * (point.y - vi.y) / (vj.y - vi.y) + vi.x;
            if (point.x < intersect_x) {
                inside = !inside;
            }
        }
        j = i;
    }

    results[idx] = select(0u, 1u, inside);
}
```

**Note**: WGSL does not natively support `f64`. If double precision is required, implement double-precision emulation using two `f32` values (double-float technique), or accept `f32` precision for GPU-accelerated paths. Document this precision trade-off. The CPU fallback always uses f64.

**File**: `rust/sedona-gpu/src/kernels/spatial_join.rs`

```rust
use arrow::record_batch::RecordBatch;

/// GPU-accelerated spatial join.
/// Falls back to CPU if GPU is not available.
pub async fn spatial_join(
    gpu: Option<&GpuContext>,
    left: &RecordBatch,   // points
    right: &RecordBatch,  // polygons
    predicate: SpatialPredicate, // ST_Within, ST_Intersects, etc.
) -> Result<RecordBatch> {
    match gpu {
        Some(ctx) if left.num_rows() > GPU_THRESHOLD => {
            gpu_spatial_join(ctx, left, right, predicate).await
        }
        _ => {
            // Use existing sedona-spatial-join CPU implementation
            cpu_spatial_join(left, right, predicate)
        }
    }
}

/// Minimum row count to justify GPU dispatch overhead.
const GPU_THRESHOLD: usize = 10_000;
```

---

### 3.3 `cereusdb-object-store` (browser I/O adapter)

**Purpose**: Bridges the `object-store-wasm` crate into SedonaDB's datasource layer.

**File**: `rust/cereusdb-object-store/Cargo.toml`

```toml
[package]
name = "cereusdb-object-store"
version = "0.4.0"
edition = "2021"

[dependencies]
object-store-wasm = "0.1"
object_store = { version = "0.12.4", default-features = false }
url = "2.5.7"
bytes = "1.11"
futures = "0.3"
async-trait = "0.1"
thiserror = "2"
log = "0.4"
```

**File**: `rust/cereusdb-object-store/src/lib.rs`

```rust
/// Create an ObjectStore for a given URL that uses browser fetch() internally.
/// Supports http://, https://, and s3:// (via pre-signed URLs).
pub fn create_wasm_object_store(url: &str) -> Result<Arc<dyn ObjectStore>>;

/// Register WASM-compatible object stores for all URL schemes
/// on a DataFusion SessionContext's RuntimeEnv.
pub fn register_wasm_stores(ctx: &SessionContext) -> Result<()>;
```

---

## 4. Emscripten build scripts

### 4.1 `wasm/build.sh` (master build script)

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/wasm/build"
INSTALL_DIR="$ROOT_DIR/wasm/sysroot"

# Parse arguments
BUILD_GEOS=true
BUILD_PROJ=true
BUILD_GDAL=false  # opt-in for full build
BUILD_TG=false
FEATURES="geos,proj"

while [[ $# -gt 0 ]]; do
    case $1 in
        --full) BUILD_GDAL=true; FEATURES="full" ;;
        --lite) BUILD_GEOS=false; BUILD_PROJ=false; FEATURES="" ;;
        --with-gdal) BUILD_GDAL=true; FEATURES="$FEATURES,gdal" ;;
        --with-gpu) FEATURES="$FEATURES,gpu" ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

echo "=== CereusDB Build ==="
echo "Features: ${FEATURES:-none}"

# Verify Emscripten is available
command -v emcc >/dev/null 2>&1 || {
    echo "Error: Emscripten (emcc) not found. Install emsdk first."
    exit 1
}

mkdir -p "$BUILD_DIR" "$INSTALL_DIR"

# Step 1: Build C/C++ dependencies with Emscripten
if [ "$BUILD_GEOS" = true ]; then
    echo "--- Building GEOS ---"
    bash "$SCRIPT_DIR/emscripten/build-geos.sh" "$BUILD_DIR/geos" "$INSTALL_DIR"
fi

if [ "$BUILD_PROJ" = true ]; then
    echo "--- Building PROJ ---"
    bash "$SCRIPT_DIR/emscripten/build-proj.sh" "$BUILD_DIR/proj" "$INSTALL_DIR"
fi

if [ "$BUILD_GDAL" = true ]; then
    echo "--- Building GDAL ---"
    bash "$SCRIPT_DIR/emscripten/build-gdal.sh" "$BUILD_DIR/gdal" "$INSTALL_DIR"
fi

if [ "$BUILD_TG" = true ]; then
    echo "--- Building TG ---"
    bash "$SCRIPT_DIR/emscripten/build-tg.sh" "$BUILD_DIR/tg" "$INSTALL_DIR"
fi

# Step 2: Build Rust WASM via wasm-pack
echo "--- Building Rust WASM ---"
export EMSCRIPTEN_SYSROOT="$INSTALL_DIR"

# Set linker flags so Rust can find the Emscripten-compiled .a files
export RUSTFLAGS="--cfg tokio_unstable \
    -L native=$INSTALL_DIR/lib \
    -C link-arg=-lm"

cd "$ROOT_DIR"

WASM_FEATURES=""
if [ -n "$FEATURES" ]; then
    WASM_FEATURES="--features $FEATURES"
fi

wasm-pack build \
    rust/cereusdb \
    --target web \
    --out-dir "$ROOT_DIR/wasm/pkg" \
    --release \
    $WASM_FEATURES

# Step 3: Optimize WASM binary
echo "--- Optimizing WASM ---"
wasm-opt -O3 \
    "$ROOT_DIR/wasm/pkg/cereusdb_bg.wasm" \
    -o "$ROOT_DIR/wasm/pkg/cereusdb_bg.wasm"

# Step 4: Report sizes
echo "--- Build complete ---"
ls -lh "$ROOT_DIR/wasm/pkg/cereusdb_bg.wasm"
echo "Gzipped size:"
gzip -c "$ROOT_DIR/wasm/pkg/cereusdb_bg.wasm" | wc -c | numfmt --to=iec
```

### 4.2 `wasm/emscripten/build-geos.sh`

```bash
#!/bin/bash
set -euo pipefail

BUILD_DIR="$1"
INSTALL_DIR="$2"
GEOS_SRC="$(dirname "$(dirname "$0")")/../third_party/geos"

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

emcmake cmake "$GEOS_SRC" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_BENCHMARKS=OFF \
    -DBUILD_DOCUMENTATION=OFF \
    -DGEOS_BUILD_DEVELOPER=OFF \
    -DCMAKE_C_FLAGS="-O2 -DNDEBUG" \
    -DCMAKE_CXX_FLAGS="-O2 -DNDEBUG -fno-exceptions"

emmake make -j$(nproc)
emmake make install
```

### 4.3 `wasm/emscripten/build-proj.sh`

```bash
#!/bin/bash
set -euo pipefail

BUILD_DIR="$1"
INSTALL_DIR="$2"
PROJ_SRC="$(dirname "$(dirname "$0")")/../third_party/proj"
SQLITE_SRC="$(dirname "$(dirname "$0")")/../third_party/sqlite"

# PROJ requires SQLite for its CRS database
# Build SQLite amalgamation first
mkdir -p "$BUILD_DIR/sqlite"
cd "$BUILD_DIR/sqlite"
emcc -O2 -DNDEBUG -DSQLITE_OMIT_LOAD_EXTENSION \
    "$SQLITE_SRC/sqlite3.c" \
    -c -o sqlite3.o
emar rcs "$INSTALL_DIR/lib/libsqlite3.a" sqlite3.o
cp "$SQLITE_SRC/sqlite3.h" "$INSTALL_DIR/include/"

# Build PROJ
mkdir -p "$BUILD_DIR/proj"
cd "$BUILD_DIR/proj"

emcmake cmake "$PROJ_SRC" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_APPS=OFF \
    -DENABLE_CURL=OFF \
    -DENABLE_TIFF=OFF \
    -DBUILD_PROJSYNC=OFF \
    -DEMBED_PROJ_DATA_PATH=ON \
    -DPROJ_DATA_PATH="$PROJ_SRC/../proj-data" \
    -DSQLITE3_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DSQLITE3_LIBRARY="$INSTALL_DIR/lib/libsqlite3.a" \
    -DCMAKE_C_FLAGS="-O2 -DNDEBUG" \
    -DCMAKE_CXX_FLAGS="-O2 -DNDEBUG"

emmake make -j$(nproc)
emmake make install
```

### 4.4 `wasm/emscripten/build-gdal.sh`

```bash
#!/bin/bash
set -euo pipefail

BUILD_DIR="$1"
INSTALL_DIR="$2"
GDAL_SRC="$(dirname "$(dirname "$0")")/../third_party/gdal"

mkdir -p "$BUILD_DIR/gdal"
cd "$BUILD_DIR/gdal"

# GDAL with minimal vector-only driver set
emcmake cmake "$GDAL_SRC" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_APPS=OFF \
    -DGDAL_BUILD_OPTIONAL_DRIVERS=OFF \
    -DOGR_BUILD_OPTIONAL_DRIVERS=OFF \
    \
    -DOGR_ENABLE_DRIVER_GEOJSON=ON \
    -DOGR_ENABLE_DRIVER_SHAPE=ON \
    -DOGR_ENABLE_DRIVER_GPKG=ON \
    -DOGR_ENABLE_DRIVER_CSV=ON \
    -DOGR_ENABLE_DRIVER_KML=ON \
    -DOGR_ENABLE_DRIVER_GML=ON \
    -DOGR_ENABLE_DRIVER_FLATGEOBUF=ON \
    -DOGR_ENABLE_DRIVER_WKT=ON \
    -DOGR_ENABLE_DRIVER_GEORSS=ON \
    -DOGR_ENABLE_DRIVER_MEMORY=ON \
    \
    -DGDAL_USE_JPEG=OFF \
    -DGDAL_USE_PNG=OFF \
    -DGDAL_USE_TIFF=OFF \
    -DGDAL_USE_GEOTIFF=OFF \
    -DGDAL_USE_CURL=OFF \
    -DGDAL_USE_GEOS=ON \
    -DGEOS_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DGEOS_LIBRARY="$INSTALL_DIR/lib/libgeos.a" \
    -DPROJ_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DPROJ_LIBRARY="$INSTALL_DIR/lib/libproj.a" \
    -DSQLITE3_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DSQLITE3_LIBRARY="$INSTALL_DIR/lib/libsqlite3.a" \
    -DCMAKE_C_FLAGS="-O2 -DNDEBUG" \
    -DCMAKE_CXX_FLAGS="-O2 -DNDEBUG"

emmake make -j$(nproc)
emmake make install
```

---

## 5. GDAL remote data access via HTTP

### 5.1 Problem

GDAL natively supports reading remote files via its `/vsicurl/` virtual filesystem, which uses libcurl for HTTP Range requests. This enables reading remote Shapefiles, GeoPackage databases, zipped archives (`/vsizip/vsicurl/https://...`), and cloud-optimized formats without downloading entire files. However, libcurl has no Emscripten backend and cannot be compiled to WASM.

### 5.2 Solution: two-tier approach (following DuckDB's pattern)

DuckDB WASM solves this without patching GDAL's `/vsicurl/` at all. In DuckDB WASM, `ST_Read('https://...some_file.shp')` works transparently because DuckDB's own virtual filesystem layer sits below GDAL and intercepts all file I/O, routing HTTP URLs through the browser's fetch API. GDAL is compiled with `-DGDAL_USE_CURL=OFF` and never touches libcurl.

For SedonaDB, we adopt a similar two-tier approach:

**Tier 1 — `/vsimem/` with pre-fetch (simple, covers most cases)**:
1. The Rust/JS layer detects that the source is an HTTP URL
2. Fetches the file (or file set for Shapefiles: .shp + .shx + .dbf + .prj) via `object-store-wasm` / browser `fetch()`
3. Loads all bytes into GDAL's `/vsimem/` in-memory filesystem
4. Opens the `/vsimem/` path with the appropriate GDAL driver
5. This works for any file size that fits in browser memory

**Tier 2 — Custom VSI handler with Emscripten fetch (for large/cloud-optimized files)**:
1. Register a custom GDAL VSI handler (`/vsihttpwasm/`) that implements `VSIFilesystemHandler`
2. The handler's `Open()`, `Read()`, `Seek()` methods use `emscripten_fetch()` with HTTP Range headers
3. This enables partial reads of large remote files (GeoPackage, zipped archives) without downloading the entire file
4. Reference implementations: `wonder-sk/wasm-gdal-sandbox` (QGIS team's proof-of-concept), `gdal3.js`

**Note**: `gdal3.js` already provides a complete GDAL+PROJ+GEOS WASM build published as an NPM package, compiling GDAL, PROJ, GEOS, SpatiaLite, SQLite, GeoTIFF, Expat, zlib, and iconv to WebAssembly. Their VSI handler implementation can be used as a reference.

### 5.3 Implementation

**Tier 1 (Phase 3 — include immediately)**:

In `cereusdb/src/io.rs`, implement the fetch-to-vsimem bridge:

```rust
/// Fetch a remote file and load it into GDAL's /vsimem/ filesystem.
/// For Shapefiles, also fetches companion files (.shx, .dbf, .prj).
async fn fetch_to_vsimem(url: &str) -> Result<String> {
    let bytes = fetch_url(url).await?; // via object-store-wasm
    let filename = url_to_filename(url);
    let vsimem_path = format!("/vsimem/{}", filename);
    gdal_vsimem_write(&vsimem_path, &bytes)?;

    // If Shapefile, fetch companions
    if url.ends_with(".shp") {
        for ext in &[".shx", ".dbf", ".prj", ".cpg"] {
            let companion_url = url.replace(".shp", ext);
            if let Ok(companion_bytes) = fetch_url(&companion_url).await {
                let companion_path = vsimem_path.replace(".shp", ext);
                gdal_vsimem_write(&companion_path, &companion_bytes)?;
            }
        }
    }
    Ok(vsimem_path)
}
```

**Tier 2 (Phase 5 — optimization)**:

Create `wasm/patches/gdal-vsi-emscripten-fetch.cpp` — a custom VSI handler that implements range-request HTTP access via Emscripten fetch. Register it as `/vsihttpwasm/`. This is only needed for large files where downloading the entire file into `/vsimem/` is impractical.

### 5.4 Supported remote access patterns

| Pattern | Tier | Example | Notes |
|---|---|---|---|
| Remote Shapefile (small) | Tier 1 | `https://example.com/data.shp` | Pre-fetches .shp + .shx + .dbf + .prj into `/vsimem/` |
| Remote GeoJSON | Tier 1 | `https://example.com/data.geojson` | Single file fetch into `/vsimem/` |
| Remote GeoPackage (small) | Tier 1 | `https://example.com/data.gpkg` | Full file fetch into `/vsimem/` |
| Remote KML/GML | Tier 1 | `https://example.com/data.kml` | Single file fetch into `/vsimem/` |
| Remote large GeoPackage | Tier 2 | `https://example.com/large.gpkg` | Range-request VSI handler avoids full download |
| Remote zipped Shapefile | Tier 1 or 2 | `https://example.com/data.zip` | Tier 1: download full zip, use `/vsizip/vsimem/`. Tier 2: range-request the zip central directory |
| Public S3 bucket | Tier 1 | `https://s3.amazonaws.com/bucket/key.shp` | Pre-fetch via unsigned HTTPS |

### 5.7 CORS constraints

### 5.6 API additions for remote GDAL sources

```rust
#[wasm_bindgen]
impl SedonaDB {
    /// Register a remote file via GDAL's /vsicurl/ virtual filesystem.
    /// Supports Shapefile, GeoPackage, KML, GML, FlatGeobuf, etc.
    /// The server must support CORS and ideally HTTP Range requests.
    /// Example: register_remote_gdal("nyc_zones", "https://example.com/zones.shp")
    #[cfg(feature = "gdal")]
    pub async fn register_remote_gdal(
        &mut self,
        table_name: &str,
        url: &str,
    ) -> Result<(), JsValue>;

    /// Register a remote zipped archive via GDAL.
    /// Uses /vsizip/vsicurl/ to read directly from the remote zip.
    /// layer_name specifies which file within the zip to open.
    /// Example: register_remote_zip("data", "https://example.com/data.zip", "data.shp")
    #[cfg(feature = "gdal")]
    pub async fn register_remote_zip(
        &mut self,
        table_name: &str,
        zip_url: &str,
        layer_name: &str,
    ) -> Result<(), JsValue>;
}
```

Add to TypeScript API:

```typescript
export class SedonaDB {
    /**
     * Register a remote geospatial file via GDAL.
     * Supports Shapefile, GeoPackage, KML, GML, FlatGeobuf over HTTP/HTTPS.
     * The server must allow CORS from the hosting origin.
     */
    async registerRemoteGDAL(name: string, url: string): Promise<void>;

    /**
     * Register a file inside a remote zip archive.
     * Reads the zip central directory first, then fetches only needed data.
     */
    async registerRemoteZip(name: string, zipUrl: string, layerName: string): Promise<void>;
}
```

### 5.7 CORS constraints

All remote GDAL access is subject to browser CORS policy. The remote server must return:

```
Access-Control-Allow-Origin: * (or the specific origin)
Access-Control-Allow-Headers: Range
Access-Control-Expose-Headers: Content-Range, Content-Length
```

Document this requirement prominently in the SDK documentation. For servers that don't support CORS, users must either use a CORS proxy or pre-fetch the file and use the file upload path.

---

## 6. TypeScript API wrapper

**File**: `wasm/js/src/index.ts`

```typescript
import init, { CereusDB as WasmCereusDB } from '../pkg/cereusdb.js';
import * as arrow from 'apache-arrow';

export interface SedonaDBOptions {
  /** Enable WebGPU acceleration if available */
  enableGpu?: boolean;
  /** Custom WASM module URL (for CDN hosting) */
  wasmUrl?: string;
}

export interface QueryResult {
  /** Arrow Table decoded from IPC */
  table: arrow.Table;
  /** Number of rows */
  numRows: number;
  /** Schema as JSON */
  schema: Record<string, string>;
  /** Raw Arrow IPC bytes */
  toIPC(): Uint8Array;
  /** Convert to array of plain JS objects */
  toJSON(): Record<string, unknown>[];
}

export class SedonaDB {
  private inner: WasmSedonaDB;
  private ready: boolean = false;

  private constructor(inner: WasmSedonaDB) {
    this.inner = inner;
    this.ready = true;
  }

  /**
   * Create and initialize a new SedonaDB instance.
   * This loads the WASM module and initializes the query engine.
   */
  static async create(options?: SedonaDBOptions): Promise<SedonaDB> {
    await init(options?.wasmUrl);
    const inner = await new WasmSedonaDB();
    return new SedonaDB(inner);
  }

  /**
   * Execute a SQL query and return results as an Arrow Table.
   */
  async sql(query: string): Promise<QueryResult> {
    const ipcBytes = await this.inner.sql(query);
    const table = arrow.tableFromIPC(ipcBytes);
    return {
      table,
      numRows: table.numRows,
      schema: Object.fromEntries(
        table.schema.fields.map(f => [f.name, f.type.toString()])
      ),
      toIPC: () => ipcBytes,
      toJSON: () => table.toArray().map(row => row.toJSON()),
    };
  }

  /**
   * Register a remote Parquet file as a table.
   * The server must support CORS and HTTP Range requests.
   */
  async registerRemoteParquet(name: string, url: string): Promise<void> {
    await this.inner.register_remote_parquet(name, url);
  }

  /**
   * Register a local file (from File API / drag-and-drop) as a table.
   * Supports Parquet, GeoJSON, and (with GDAL) Shapefile, GeoPackage, etc.
   */
  async registerFile(name: string, file: File): Promise<void> {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'parquet' || ext === 'geoparquet') {
      await this.inner.register_parquet_buffer(name, buffer);
    } else if (ext === 'geojson' || ext === 'json') {
      const text = new TextDecoder().decode(buffer);
      this.inner.register_geojson(name, text);
    } else {
      // Attempt GDAL-based registration (requires gdal feature)
      await this.inner.register_file_buffer(name, file.name, buffer);
    }
  }

  /**
   * Register a GeoJSON object or string as a table.
   */
  registerGeoJSON(name: string, geojson: string | object): void {
    const str = typeof geojson === 'string' ? geojson : JSON.stringify(geojson);
    this.inner.register_geojson(name, str);
  }

  /** Drop a table. */
  dropTable(name: string): void { this.inner.drop_table(name); }

  /** List registered tables. */
  tables(): string[] { return this.inner.tables(); }

  /** Check if WebGPU acceleration is available. */
  async hasWebGPU(): Promise<boolean> { return this.inner.has_webgpu(); }

  /** Version string. */
  version(): string { return this.inner.version(); }
}
```

**File**: `wasm/js/src/worker.ts`

```typescript
/// Web Worker wrapper for off-main-thread query execution.
/// Prevents long-running queries from blocking the UI thread.

import { SedonaDB } from './index';

let db: SedonaDB | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { id, method, args } = e.data;
  try {
    if (method === 'init') {
      db = await CereusDB.create(args[0]);
      self.postMessage({ id, result: true });
    } else if (db && method in db) {
      const result = await (db as any)[method](...args);
      // Transfer Arrow IPC bytes without copying if possible
      if (result?.toIPC) {
        const ipc = result.toIPC();
        self.postMessage({ id, result: { ipc, numRows: result.numRows } }, [ipc.buffer]);
      } else {
        self.postMessage({ id, result });
      }
    }
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
```

---

## 7. NPM package

**File**: `wasm/js/package.json`

```json
{
  "name": "@cereusdb/cereusdb",
  "version": "0.4.0",
  "description": "Apache SedonaDB — geospatial analytical database for the browser via WebAssembly",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "files": [
    "dist/",
    "pkg/"
  ],
  "scripts": {
    "build": "cd ../.. && bash wasm/build.sh && cd wasm/js && tsc",
    "build:full": "cd ../.. && bash wasm/build.sh --full && cd wasm/js && tsc",
    "build:lite": "cd ../.. && bash wasm/build.sh --lite && cd wasm/js && tsc",
    "test": "node tests/wasm-test-runner.js"
  },
  "keywords": [
    "geospatial", "gis", "spatial", "sql", "wasm", "webassembly",
    "geoparquet", "arrow", "datafusion", "webgpu"
  ],
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/apache/sedona-db.git"
  },
  "peerDependencies": {
    "apache-arrow": ">=17.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "apache-arrow": "^17.0.0"
  }
}
```

---

## 8. Test plan

### 7.1 Unit tests (Rust, run via `wasm-pack test`)

| Test file | What it tests |
|---|---|
| `cereusdb/tests/test_context.rs` | SedonaDB construction, function registration |
| `cereusdb/tests/test_spatial_functions.rs` | All `ST_*` functions via SQL: ST_Point, ST_Distance, ST_Contains, ST_Buffer, ST_Intersects, ST_Area, ST_Centroid, ST_Union, ST_Transform |
| `cereusdb/tests/test_geoparquet.rs` | Read GeoParquet from in-memory bytes, verify geometry column decoding |
| `cereusdb/tests/test_formats.rs` | Register GeoJSON, WKT; query back |
| `sedona-gpu/tests/test_pip.rs` | Point-in-polygon kernel correctness vs CPU reference |
| `sedona-gpu/tests/test_distance.rs` | Distance matrix kernel correctness vs CPU reference |
| `sedona-gpu/tests/test_fallback.rs` | GPU unavailable → falls back to CPU without error |

Run with:
```bash
wasm-pack test --headless --chrome rust/cereusdb
wasm-pack test --headless --chrome rust/sedona-gpu
```

### 7.2 Integration tests (JavaScript, run in browser)

| Test file | What it tests |
|---|---|
| `test_spatial_functions.js` | End-to-end: JS → SedonaDB.sql() → Arrow Table, verify values |
| `test_remote_parquet.js` | Load remote GeoParquet via HTTPS, execute spatial query |
| `test_file_upload.js` | Simulate File API upload of .parquet, .geojson, .shp |
| `test_remote_gdal.js` | Load remote Shapefile and GeoPackage via `/vsicurl/` over HTTPS |
| `test_remote_zip.js` | Load file from remote zip archive via `/vsizip/vsicurl/` |
| `test_webgpu.js` | WebGPU spatial join: verify results match CPU path |
| `test_worker.js` | Web Worker: verify off-main-thread query execution |

### 7.3 Benchmarks

| Benchmark | Comparison |
|---|---|
| Spatial join (100K points × 1K polygons) | CPU vs WebGPU, SedonaDB WASM vs DuckDB WASM spatial |
| GeoParquet scan + filter (1M rows) | SedonaDB WASM vs DuckDB WASM |
| ST_Buffer on 100K geometries | SedonaDB WASM (GEOS) vs DuckDB WASM (GEOS) |
| Remote Parquet range read latency | SedonaDB WASM vs DuckDB WASM |

---

## 9. Implementation phases

### Phase 1: Pure Rust core (2-4 weeks)

**Tasks**:

1. Create `rust/cereusdb/` crate scaffold with `Cargo.toml` and `lib.rs`
2. Add `wasm` feature flag to workspace `Cargo.toml` and propagate to `sedona`, `sedona-datasource`
3. Create `rust/cereusdb-object-store/` adapter crate
4. `#[cfg(not(target_arch = "wasm32"))]` gate all `tokio::spawn_blocking` calls in `sedona-datasource`
5. Replace `mimalloc` global allocator with conditional compilation: use default allocator on WASM
6. Get `wasm-pack build` to compile successfully with `--features ""` (no C deps)
7. Implement `SedonaDB::new()`, `sql()`, `sql_json()` in `cereusdb`
8. Implement `register_parquet_buffer()` and `register_geojson()`
9. Implement `register_remote_parquet()` via `object-store-wasm`
10. Create `wasm/js/` TypeScript wrapper and `package.json`
11. Write unit tests for core spatial functions via SQL
12. Create `wasm/js/examples/basic-query.html` demo

**Exit criteria**: `SELECT ST_Distance(ST_Point(0,0), ST_Point(1,1))` returns correct result in a browser. Remote GeoParquet file can be queried.

### Phase 2: GEOS + PROJ via Emscripten (3-6 weeks)

**Tasks**:

1. Add `third_party/geos`, `third_party/proj`, `third_party/sqlite` as git submodules
2. Write `wasm/emscripten/build-geos.sh` and verify `libgeos.a` is produced
3. Write `wasm/emscripten/build-proj.sh` with embedded PROJ.db and verify `libproj.a` is produced
4. Modify `c/sedona-geos/build.rs` to detect WASM target and link against Emscripten `.a` instead of system lib
5. Modify `c/sedona-proj/build.rs` similarly
6. Verify `wasm-pack build --features geos,proj` succeeds
7. Test all GEOS-dependent `ST_*` functions: ST_Buffer, ST_Union, ST_Intersection, ST_IsValid, ST_MakeValid, ST_Simplify, ST_ConvexHull, ST_Envelope
8. Test `ST_Transform` with EPSG:4326 ↔ EPSG:3857, UTM zones
9. Write `wasm/build.sh` master build script
10. Measure and document binary size impact

**Exit criteria**: All GEOS-backed functions pass. `ST_Transform(geom, 'EPSG:4326', 'EPSG:3857')` works correctly.

### Phase 3: GDAL with remote access (3-5 weeks)

**Tasks**:

1. Add `third_party/gdal`, `third_party/zlib`, `third_party/expat` as submodules
2. Write `wasm/emscripten/build-gdal.sh` with curated driver list
3. Create `wasm/patches/gdal-vsicurl-emscripten.patch` — patch GDAL's `/vsicurl/` handler to use Emscripten's `emscripten_fetch()` API instead of libcurl, using `wasm-gdal-sandbox` and `gdal3.js` as reference implementations
4. Modify `c/sedona-gdal/build.rs` for WASM target detection
5. Implement `register_file_buffer()` in `cereusdb` that loads bytes into `/vsimem/` and opens via GDAL
6. Implement `register_remote_gdal()` that opens via `/vsicurl/` using the patched fetch backend
7. Implement `register_remote_zip()` that opens via `/vsizip/vsicurl/`
8. Test: local Shapefile upload + query, local GeoPackage upload + query, local KML upload + query
9. Test: remote Shapefile via HTTPS (CORS-enabled server), remote zipped Shapefile
10. Add `--with-gdal` flag to `wasm/build.sh`
11. Create `wasm/js/examples/file-upload.html` demo with drag-and-drop
12. Create `wasm/js/examples/remote-shapefile.html` demo loading from URL

**Exit criteria**: User can drag-and-drop a Shapefile into the browser and query it with spatial SQL. User can also point at a remote HTTPS URL hosting a Shapefile or GeoPackage and query it directly without downloading the full file.

### Phase 4: WebGPU acceleration (4-8 weeks)

**Tasks**:

1. Create `rust/sedona-gpu/` crate scaffold
2. Implement `GpuContext::try_init()` with `wgpu`
3. Implement `buffers.rs`: Arrow ↔ GPU buffer conversion
4. Write `point_in_polygon.wgsl` compute shader and `point_in_polygon.rs` dispatch
5. Write `distance_matrix.wgsl` compute shader and `distance.rs` dispatch
6. Write `spatial_join.wgsl` and `spatial_join.rs` for GPU-accelerated spatial join
7. Write `raster_algebra.wgsl` for map algebra operations
8. Implement graceful fallback: `try_init()` returns `None` → CPU path
9. Integrate GPU kernels into DataFusion physical plan nodes
10. Benchmark GPU vs CPU for spatial join at 10K, 100K, 1M points
11. Document f64 vs f32 precision trade-offs
12. Create `wasm/js/examples/webgpu-spatial-join.html` demo

**Exit criteria**: GPU spatial join produces correct results matching CPU path. 10x+ speedup demonstrated for 100K+ point datasets on supported hardware.

### Phase 5: Polish + publish (2-3 weeks)

**Tasks**:

1. Binary size optimization: `wasm-opt -O3`, enable LTO in `Cargo.toml`, tree-shake unused DataFusion features
2. Split builds: `build.sh --lite` (5-10MB) vs `build.sh --full` (15-25MB)
3. Complete TypeScript type definitions
4. Write README.md with usage examples
5. Set up NPM publish pipeline
6. Set up CI: GitHub Actions building WASM on each PR
7. Web Worker integration testing
8. Cross-browser testing: Chrome, Firefox, Safari
9. Performance benchmarks vs DuckDB WASM spatial
10. Write `CONTRIBUTING.md` section on WASM development

**Exit criteria**: NPM package published. All examples work in Chrome, Firefox, Safari. CI green.

---

## 10. Acceptance criteria summary

The SedonaDB WASM build is considered complete when:

1. All pure-Rust `ST_*` spatial functions pass tests in a browser environment
2. All GEOS-backed `ST_*` functions pass tests via Emscripten-compiled GEOS
3. `ST_Transform` works with common CRS codes via Emscripten-compiled PROJ
4. Remote GeoParquet files can be queried over HTTP with spatial predicates
5. Local file upload works for Parquet, GeoJSON, and (with GDAL) Shapefile/GeoPackage
6. Remote file access works for GeoParquet (via object-store-wasm) and for Shapefile/GeoPackage/KML (via GDAL vsicurl/Emscripten fetch) from CORS-enabled HTTP servers
7. WebGPU acceleration produces correct results and demonstrates measurable speedup
8. Graceful CPU fallback works when WebGPU is unavailable
9. Published NPM package installs and runs in Chrome, Firefox, and Safari
10. TypeScript types are complete and accurate
11. Binary size is documented: lite variant under 15MB gzipped, full variant under 30MB gzipped
