# CereusDB

A custom WebAssembly (Wasm) build of [Apache SedonaDB](https://github.com/apache/sedona-db) for browser-side spatial SQL. Named for the desert cactus genus Cereus (/ˈsɪəriəs/ — "serious"), a nod to its Sedona roots.

## Overview

CereusDB compiles SedonaDB's spatial SQL engine (built on [Apache DataFusion](https://datafusion.apache.org/) and [Apache Arrow](https://arrow.apache.org/)) to WebAssembly, with optional GEOS, PROJ, GDAL, and opt-in S2 geography support cross-compiled via Emscripten.

The repository keeps upstream sources in git submodules and applies local WASM
compatibility changes from `patches/` into generated trees under
`build/patched-sources/`.

The public WASM packages now enable SedonaDB's spatial join planner path,
including relation joins, distance joins, and `ST_KNN`, in a constrained
browser MVP: single-partition, in-memory, sequential refinement, with no
spill-to-disk or out-of-core execution.

### Browser packages

| Build | Features | Raw size | Gzipped |
|---|---|---|---|
| `minimal` | Core + `geo` + GEOS + spatial joins / `ST_KNN` MVP | 21 MB | 6.2 MB |
| `standard` | `minimal` + PROJ / `ST_Transform` | 41 MB | 10.9 MB |
| `global` | `standard` + opt-in S2 geography kernels | 43 MB | 12.0 MB |
| `full` | `global` + GDAL-backed raster ingestion and the full current local `RS_*` catalog | 50 MB | 14.5 MB |

`full` is the maximum browser build target. It now combines GEOS, PROJ, S2, and GDAL. It adds browser-side GeoTIFF/TIFF upload plus the full current SedonaDB/Rust raster SQL surface (`33` `RS_*` functions), including `RS_Contains`, `RS_Intersects`, and `RS_Within`. Raster ingestion remains host-driven through `registerGeoTIFF()` / `registerRaster()`. SQL-side raster loader functions are not exposed in the browser WASM build.

S2 geography is available in `global` and `full`. The
verified native `sedona-s2geography` scalar kernel family is exposed there,
plus the S2-backed `sd_order` override for lon/lat geography values.

### npm packages

Each public browser artifact is published as its own npm package:

| Package | Build |
|---|---|
| `@cereusdb/minimal` | `minimal` |
| `@cereusdb/standard` | `standard` |
| `@cereusdb/global` | `global` |
| `@cereusdb/full` | `full` |

The repository also contains two private Pages-deployed apps under `packages/`:

- `packages/documentation` for the Typedoc site
- `packages/playground` for the interactive browser playground built on `@cereusdb/standard`

### Spatial join MVP limits

Regular spatial joins, distance joins, and `ST_KNN` are enabled in `minimal`,
`standard`, `global`, and `full`, but the browser runtime intentionally stays on a
constrained execution profile:

- one spatial partition
- in-memory only
- sequential refinement
- no spill files
- no out-of-core multi-partition spatial join execution

Verified relation predicates through `SpatialJoinExec` currently include:
`ST_Intersects`, `ST_Contains`, `ST_Within`, `ST_Covers`, `ST_CoveredBy`,
`ST_Touches`, `ST_Crosses`, `ST_Overlaps`, and `ST_Equals`.

Verified distance join forms currently include:
`ST_DWithin(left.geom, right.geom, literal_distance)` and
`ST_Distance(left.geom, right.geom) < literal_distance`.

The browser KNN contract currently includes:
- `ST_KNN(query_geom, object_geom)`
- `ST_KNN(query_geom, object_geom, k)`
- `ST_KNN(query_geom, object_geom, k, use_spheroid_literal)`

The current browser MVP does not support non-literal `k`, non-literal
`use_spheroid`, geography inputs to `ST_KNN`, or `OR`-composed `ST_KNN`
predicates.

## Quick start

```javascript
import { CereusDB } from '@cereusdb/standard';

const db = await CereusDB.create();

// Spatial query
const result = await db.sqlJSON(
  "SELECT ST_AsText(ST_Buffer(ST_Point(0, 0), 1.0)) AS buffered"
);
console.log(result);

// CRS transformation (standard, global, or full build)
const projected = await db.sqlJSON(`
  SELECT ST_AsText(ST_Transform(
    ST_GeomFromWKT('POINT(13.4 52.5)'),
    'EPSG:4326', 'EPSG:3857'
  )) AS result
`);

// Load remote Parquet
await db.registerRemoteParquet('cities', 'https://example.com/cities.parquet');
const cities = await db.sqlJSON("SELECT * FROM cities WHERE ST_Within(geometry, ST_Buffer(ST_Point(13.4, 52.5), 0.5))");
```

For local browser examples without npm packaging, the generated wasm-bindgen
loader remains available under `dist/<package>/cereusdb.js` and the `pkg/`
symlink points at the most recently built artifact.

## API

| Method | Description |
|---|---|
| `CereusDB.create()` | Create a new instance with all spatial functions registered |
| `db.sql(query)` | Execute SQL, return Arrow IPC bytes (`Uint8Array`) |
| `db.sqlJSON(query)` | Execute SQL and return parsed JSON rows |
| `db.registerFile(name, file)` | Register a browser `File` as Parquet, GeoJSON, or GeoTIFF/TIFF |
| `db.registerRemoteParquet(name, url)` | Fetch and register a remote Parquet file (CORS required) |
| `db.registerGeoJSON(name, geojson)` | Register a GeoJSON string or object as a table |
| `db.registerRaster(name, bytes, format)` | Register raster bytes as a single-column raster table (`full` only, currently `geotiff` / `tiff`) |
| `db.registerGeoTIFF(name, bytes)` | Register GeoTIFF bytes as a single-column raster table (`full` only) |
| `db.dropTable(name)` | Drop a registered table |
| `db.tables()` | List registered table names |
| `db.version()` | Version string |

## Spatial function reference

### Core functions (always available)

66 scalar + 3 aggregate functions from pure Rust.

#### Constructors
`ST_Point`, `ST_PointZ`, `ST_PointM`, `ST_PointZM`, `ST_GeogPoint`

#### Parsers
`ST_GeomFromWKT`, `ST_GeomFromWKB`, `ST_GeomFromEWKT`, `ST_GeomFromEWKB`, `ST_GeogFromWKT`, `ST_GeogFromWKB`, `ST_GeomFromWKBUnchecked`

#### Serializers
`ST_AsText`, `ST_AsBinary`, `ST_AsEWKB`, `ST_AsEWKT`

#### Coordinate accessors
`ST_X`, `ST_Y`, `ST_Z`, `ST_M`

#### Bounding box
`ST_XMin`, `ST_XMax`, `ST_YMin`, `ST_YMax`, `ST_ZMin`, `ST_ZMax`, `ST_MMin`, `ST_MMax`

#### CRS / SRID
`ST_SRID`, `ST_SetSRID`, `ST_CRS`, `ST_SetCRS`

#### Properties
`ST_Dimension`, `ST_GeometryType`, `ST_NumGeometries`, `ST_NPoints`, `ST_IsEmpty`, `ST_IsClosed`, `ST_IsCollection`, `ST_HasZ`, `ST_HasM`, `ST_ZMFlag`

#### Component access
`ST_GeometryN`, `ST_PointN`, `ST_Points`, `ST_StartPoint`, `ST_EndPoint`, `ST_InteriorRingN`

#### Geometry operations
`ST_Envelope`, `ST_Dump`, `ST_MakeLine`, `ST_Reverse`

#### Affine transforms
`ST_Translate`, `ST_Scale`, `ST_Rotate`, `ST_RotateX`, `ST_RotateY`, `ST_Affine`

#### Dimension forcing
`ST_Force2D`, `ST_Force3D`, `ST_Force3DM`, `ST_Force4D`

#### Aggregates
`ST_Collect_Agg`, `ST_Envelope_Agg`, `ST_Analyze_Agg`

### Geo functions (always available)

10 scalar + 2 aggregate functions from the pure-Rust `geo` crate.

#### Measurement
`ST_Area`, `ST_Length`, `ST_Perimeter`, `ST_Distance`, `ST_DWithin`

#### Geometry operations
`ST_Buffer`, `ST_Centroid`, `ST_Intersects`, `ST_LineInterpolatePoint`

#### Serializers
`ST_AsGeoJSON`

#### Aggregates
`ST_Intersection_Agg`, `ST_Union_Agg`

### GEOS functions (`minimal`, `standard`, `global`, `full`)

42 scalar + 1 aggregate function via GEOS 3.13.1 (C++ cross-compiled with Emscripten).

#### Spatial predicates
`ST_Contains`, `ST_Within`, `ST_Covers`, `ST_CoveredBy`, `ST_Crosses`, `ST_Touches`, `ST_Overlaps`, `ST_Disjoint`, `ST_Equals`, `ST_Relate`

#### Validation
`ST_IsValid`, `ST_IsValidReason`, `ST_IsSimple`, `ST_IsRing`, `ST_MakeValid`

#### Overlay operations
`ST_Intersection`, `ST_Union`, `ST_Difference`, `ST_SymDifference`

#### Hulls
`ST_ConvexHull`, `ST_ConcaveHull`

#### Simplification
`ST_Simplify`, `ST_SimplifyPreserveTopology`

#### Topology
`ST_Boundary`, `ST_UnaryUnion`, `ST_LineMerge`, `ST_Polygonize`, `ST_Snap`

#### Precision
`ST_MinimumClearance`, `ST_MinimumClearanceLine`

#### Properties
`ST_NRings`, `ST_NumInteriorRings`, `ST_NumPoints`

#### Aggregates
`ST_Polygonize_Agg`

### PROJ functions (`standard`, `global`, `full`)

1 scalar function via PROJ 9.6.0 (C++ cross-compiled with Emscripten).

`ST_Transform` — CRS reprojection (supports EPSG codes, PROJ strings, WKT2)

### Raster functions (`full`)

33 `RS_*` functions via GDAL-backed raster support. The `full` package matches the
current local SedonaDB/Rust raster catalog and includes raster metadata,
georeference, pixel geometry, and predicate functions such as `RS_Width`,
`RS_Height`, `RS_NumBands`, `RS_BandPixelType`, `RS_CRS`, `RS_GeoReference`,
`RS_PixelAsPoint`, `RS_PixelAsPolygon`, `RS_Contains`, `RS_Intersects`, and
`RS_Within`.

### Comparison with native SedonaDB

| Category | sedona-db (native) | cereusdb |
|---|---|---|
| Vector scalar functions | Current SedonaDB/Rust catalog | Up to 132 exposed runtime names (`global` / `full`) |
| Vector aggregate functions | 6 | 6 |
| Raster functions (RS_*) | 33 | 33 in `full` |
| S2 geography functions | 18 | 18 in `global` / `full` |
| CRS transform | ST_Transform | ST_Transform |
| GEOS predicates & operations | All | All |
| Spatial join | Yes (with spill-to-disk) | Yes (single-partition, in-memory MVP) |
| KNN join (`ST_KNN`) | Yes | Yes (same MVP limitations) |
| Remote Parquet (HTTP) | Yes | Yes (pre-fetch) |
| GeoParquet metadata | Yes | -- |
| File upload (Parquet, GeoJSON) | N/A | Yes |

### Package Function Availability

Current generated runtime counts per browser artifact:

| Package | Runtime `ST_*` | Runtime `RS_*` | What it adds | What it omits |
|---|---:|---:|---|---|
| `minimal` | 130 | 0 | Core, `geo`, GEOS, spatial joins, `ST_KNN` MVP | `ST_Transform`, all raster, all S2 geography kernels |
| `standard` | 131 | 0 | `ST_Transform` | all raster, all S2 geography kernels |
| `global` | 132 | 0 | `ST_Transform`, 18 S2 geography kernels, S2 `sd_order` override | all raster |
| `full` | 132 | 33 | `ST_Transform`, 18 S2 geography kernels, S2 `sd_order` override, full current raster catalog | nothing from the current local SedonaDB docs set |

Common runtime-only names exposed across the packages include:

- Compatibility aliases: `ST_AsWKB`, `ST_AsWKT`, `ST_GeogFromText`, `ST_GeomFromText`, `ST_GeometryFromText`
- Geography additions: `ST_GeogFromEWKB`, `ST_GeogFromEWKT`, `ST_GeogToGeometry`, `ST_GeomToGeography`
- Local broad-doc extensions: `ST_AsEWKT`, `ST_Expand`, `ST_ExteriorRing`, `ST_GeomFromGeoJSON`, `ST_MakeEnvelope`
- Runtime helpers: `ST_GeomFromWKBUnchecked`, `ST_NRings`, `ST_NumInteriorRings`, `ST_NumPoints`

## Building

### Prerequisites

- Rust (1.88+) with `wasm32-unknown-unknown` target
- [wasm-pack](https://rustwasm.github.io/wasm-pack/)
- [Emscripten](https://emscripten.org/) (for `minimal`, `standard`, `global`, or `full`)

### Build commands

```bash
# Initialize submodules once
make deps

# Prepare patched source trees
make prepare-sources

# Validate the Rust baseline
make check

# Public browser packages
make build
make build-minimal
make build-standard
make build-global
make build-full

# JavaScript wrapper and tests
make install-js-deps
make build-js
make build-ts
make package-minimal
make package-standard
make package-global
make package-full
make package-all
make test-js
make test-js-minimal
make test-js-standard
make test-js-global
make test-js-full

# Size reporting
make size-minimal
make size-standard
make size-global
make size-full
make size-report

# Regenerate the package surface snapshot report
make surface-report
```

Each package build writes to `dist/<package>/`. The repository-level `pkg/` path is a symlink to the most recently built package so the JS wrapper and tests can keep importing `./pkg/cereusdb.js`. The publishable npm package shells live under `packages/minimal`, `packages/standard`, `packages/global`, and `packages/full`; `make package-*` assembles each of them from the matching built WASM artifact plus the shared TypeScript wrapper.

### Local development

```bash
make install-playground-deps
make package-standard
make serve
# Open http://127.0.0.1:8080
```

The Vite playground in `packages/playground` replaces the old static HTML demos. It uses `@cereusdb/standard`, supports ad hoc SQL queries, remote Parquet loading, local Parquet/GeoJSON uploads, and result inspection in both table and JSON form.

### JavaScript tests

```bash
# Package-specific rebuild + TypeScript compile + Vitest
make test-js-minimal
make test-js-standard
make test-js-global
make test-js-full

# Or run the JS steps directly once dependencies are installed
cd js
npm exec tsc
npm run test:minimal
npm run test:standard
npm run test:global
npm run test:full
```

## Architecture

```
CereusDB/
├── deps/
│   ├── sedona-db/          # Git submodule (never modified)
│   ├── geos/               # GEOS 3.13.1 source
│   ├── proj/               # PROJ 9.6.0 source
│   ├── gdal/               # GDAL source
│   ├── expat/              # Expat source
│   ├── zlib/               # zlib source
│   ├── sqlite-src/         # SQLite source
│   ├── georust-geos/       # geos / geos-sys source
│   ├── georust-proj/       # proj / proj-sys source
│   └── georust-gdal/       # gdal / gdal-sys source
├── patches/
│   ├── sedona-db/          # sedona-db WASM patch series
│   ├── georust-geos/       # georust/geos WASM patch series
│   ├── georust-proj/       # georust/proj WASM patch series
│   └── georust-gdal/       # georust/gdal WASM patch series
├── rust/
│   ├── cereusdb/           # WASM entry point (wasm-bindgen API)
│   └── cereusdb-object-store/
├── scripts/
│   ├── build.sh            # Master build script
│   ├── prepare-patched-sources.sh
│   ├── report-wasm-size.sh # Raw/gzip/brotli size reporting
│   ├── patch-wasm-js.sh    # Post-build JS patching
│   ├── env_shim.js         # Emscripten runtime stubs
│   └── emscripten/         # GEOS/PROJ Emscripten build scripts
├── build/
│   └── patched-sources/    # Generated patched source trees (not committed)
├── dist/                   # Package outputs (minimal, standard, global, full)
├── packages/               # npm package shells and private Pages apps
│   ├── documentation/      # Typedoc site source and deployment config
│   ├── playground/         # Browser playground built on @cereusdb/standard
│   └── <package>/          # @cereusdb/minimal|standard|global|full shells
├── pkg -> dist/<package>   # Symlink to the most recently built package
├── js/
│   ├── src/index.ts        # Internal shared TypeScript wrapper source
│   └── tests/              # Vitest package matrix
├── Cargo.toml              # Workspace root
├── Makefile
└── DEPENDENCIES.md
```

## License

Apache-2.0
