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

Signatures and descriptions below are sourced from the [Apache SedonaDB SQL function reference](https://sedona.apache.org/sedonadb/latest-snapshot/reference/sql/). Entries marked _(local runtime helper)_ are exposed by the cereusdb build but are not documented upstream.

### Core functions (always available)

66 scalar + 3 aggregate functions from pure Rust.

#### Constructors

- **ST_Point** — `geometry ST_Point(x: double, y: double, srid: crs)` — Constructs a Point from X and Y.
- **ST_PointZ** — `geometry ST_PointZ(x: double, y: double, z: double)` — Constructs a Point with a Z coordinate.
- **ST_PointM** — `geometry ST_PointM(x: double, y: double, m: double)` — Constructs a Point with an M (measure) coordinate.
- **ST_PointZM** — `geometry ST_PointZM(x: double, y: double, z: double, m: double)` — Constructs a Point with X, Y, Z, and M coordinates.
- **ST_GeogPoint** — `geography ST_GeogPoint(longitude: double, latitude: double)` — Creates a geography POINT from longitude and latitude.

#### Parsers

- **ST_GeomFromWKT** — `geometry ST_GeomFromWKT(wkt: string)` · `geometry ST_GeomFromWKT(wkt: string, srid: crs)` — Constructs a Geometry from Well-Known Text.
- **ST_GeomFromWKB** — `geometry ST_GeomFromWKB(wkb: binary)` · `geometry ST_GeomFromWKB(wkb: binary, srid: crs)` — Constructs a Geometry from Well-Known Binary.
- **ST_GeomFromEWKT** — `geometry ST_GeomFromEWKT(ewkt: string)` — Constructs a geometry from Extended Well-Known Text.
- **ST_GeomFromEWKB** — `geometry ST_GeomFromEWKB(ewkb: binary)` — Constructs a geometry from Extended Well-Known Binary.
- **ST_GeogFromWKT** — `geography ST_GeogFromWKT(wkt: string)` · `geography ST_GeogFromWKT(wkt: string, srid: integer)` — Constructs a Geography from WKT.
- **ST_GeogFromWKB** — `geography ST_GeogFromWKB(wkb: binary)` — Constructs a Geography from WKB.
- **ST_GeomFromWKBUnchecked** — `geometry ST_GeomFromWKBUnchecked(wkb: binary)` — _(local runtime helper)_ constructs a Geometry from WKB without validation.

#### Serializers

- **ST_AsText** — `string ST_AsText(geom: geometry)` — Returns the WKT string representation of a geometry or geography.
- **ST_AsBinary** — `binary ST_AsBinary(geom: geometry)` — Converts a geometry to Well-Known Binary format.
- **ST_AsEWKB** — `binary ST_AsEWKB(geom: geometry)` — Returns the EWKB representation of a geometry or geography.
- **ST_AsEWKT** — `string ST_AsEWKT(geom: geometry)` — _(local extension)_ returns the Extended WKT representation of a geometry.

#### Coordinate accessors

- **ST_X** — `double ST_X(geom: geometry)` — Returns the X coordinate of the point, or NULL if not available.
- **ST_Y** — `double ST_Y(geom: geometry)` — Returns the Y coordinate of the point, or NULL if not available.
- **ST_Z** — `double ST_Z(geom: geometry)` — Returns the Z coordinate of the point, or NULL if not available.
- **ST_M** — `double ST_M(geom: geometry)` — Returns the M (measure) coordinate of a Point geometry.

#### Bounding box

- **ST_XMin** — `double ST_XMin(geom: geometry)` — Returns the minimum X coordinate of a geometry's bounding box.
- **ST_XMax** — `double ST_XMax(geom: geometry)` — Returns the maximum X coordinate of a geometry's bounding box.
- **ST_YMin** — `double ST_YMin(geom: geometry)` — Returns the minimum Y coordinate of a geometry's bounding box.
- **ST_YMax** — `double ST_YMax(geom: geometry)` — Returns the maximum Y coordinate of a geometry's bounding box.
- **ST_ZMin** — `double ST_ZMin(geom: geometry)` — Returns the minimum Z coordinate of a geometry's bounding box.
- **ST_ZMax** — `double ST_ZMax(geom: geometry)` — Returns the maximum Z coordinate of a geometry's bounding box.
- **ST_MMin** — `double ST_MMin(geom: geometry)` — Returns the minimum M-coordinate of a geometry's bounding box.
- **ST_MMax** — `double ST_MMax(geom: geometry)` — Returns the maximum M value from a geometry's bounding box.

#### CRS / SRID

- **ST_SRID** — `integer ST_SRID(geom: geometry)` — Returns the SRID of a geometry.
- **ST_SetSRID** — `geometry ST_SetSRID(geom: geometry, srid: integer)` — Sets the SRID for a geometry.
- **ST_CRS** — `string ST_CRS(geom: geometry)` — Returns the CRS metadata associated with a geometry or geography object.
- **ST_SetCRS** — `geometry ST_SetCRS(geom: geometry, target_crs: string)` · `geography ST_SetCRS(geog: geography, target_crs: string)` — Sets the CRS for a geometry.

#### Properties

- **ST_Dimension** — `integer ST_Dimension(geom: geometry)` — Returns the dimension of the geometry.
- **ST_GeometryType** — `string ST_GeometryType(geom: geometry)` — Returns the type of a geometry.
- **ST_NumGeometries** — `integer ST_NumGeometries(geom: geometry)` — Returns the number of geometries in a geometry collection.
- **ST_NPoints** — `integer ST_NPoints(geom: geometry)` — Returns the number of points of the geometry.
- **ST_IsEmpty** — `boolean ST_IsEmpty(geom: geometry)` — Returns true if the geometry is empty.
- **ST_IsClosed** — `boolean ST_IsClosed(geom: geometry)` — Returns true if the LINESTRING start and end point are the same.
- **ST_IsCollection** — `boolean ST_IsCollection(geom: geometry)` — Returns true if the geometry type is a geometry collection type.
- **ST_HasZ** — `boolean ST_HasZ(geom: geometry)` — Returns true if the geometry has a Z dimension.
- **ST_HasM** — `boolean ST_HasM(geom: geometry)` — Returns true if the geometry has an M dimension.
- **ST_ZMFlag** — `integer ST_ZMFlag(geom: geometry)` — Returns a code indicating the dimension of the coordinates in a geometry.

#### Component access

- **ST_GeometryN** — `geometry ST_GeometryN(geom: geometry, n: integer)` — Returns the 0-based Nth geometry from a geometry collection or multi-type.
- **ST_PointN** — `geometry ST_PointN(geom: geometry, n: integer)` — Returns the Nth point in a linestring.
- **ST_Points** — `geometry ST_Points(geom: geometry)` — Returns a MultiPoint geometry consisting of all coordinates of the input geometry.
- **ST_StartPoint** — `geometry ST_StartPoint(geom: geometry)` — Returns the start point of a linestring geometry.
- **ST_EndPoint** — `geometry ST_EndPoint(geom: geometry)` — Returns the last point of a linestring.
- **ST_InteriorRingN** — `geometry ST_InteriorRingN(geom: geometry, n: integer)` — Returns the Nth interior ring of a polygon.

#### Geometry operations

- **ST_Envelope** — `geometry ST_Envelope(geom: geometry)` — Returns the bounding box (envelope) of a geometry as a new geometry.
- **ST_Dump** — `struct ST_Dump(geom: geometry)` — Expands multi-part geometries into child parts.
- **ST_MakeLine** — `geometry ST_MakeLine(geomA: geometry, geomB: geometry)` — Creates a LineString from two or more input geometries.
- **ST_Reverse** — `geometry ST_Reverse(geom: geometry)` — Returns the geometry with vertex order reversed.

#### Affine transforms

- **ST_Translate** — `geometry ST_Translate(geom: geometry, deltaX: double, deltaY: double)` · `geometry ST_Translate(geom: geometry, deltaX: double, deltaY: double, deltaZ: double)` — Returns a geometry with coordinates translated by deltaX, deltaY (and optional deltaZ).
- **ST_Scale** — `geometry ST_Scale(geom: geometry, scaleX: double, scaleY: double)` · `geometry ST_Scale(geom: geometry, scaleX: double, scaleY: double, scaleZ: double)` — Scales a geometry by multiplying ordinates with scale factors.
- **ST_Rotate** — `geometry ST_Rotate(geom: geometry, rot: double)` — Rotates a geometry counter-clockwise around the Z axis by an angle in radians.
- **ST_RotateX** — `geometry ST_RotateX(geom: geometry, rot: double)` — Rotates a geometry around the X axis by an angle in radians.
- **ST_RotateY** — `geometry ST_RotateY(geom: geometry, rot: double)` — Rotates a geometry around the Y axis by an angle in radians.
- **ST_Affine** — `geometry ST_Affine(geom: geometry, a: double, b: double, d: double, e: double, xOff: double, yOff: double)` · `geometry ST_Affine(geom: geometry, a: double, b: double, c: double, d: double, e: double, f: double, g: double, h: double, i: double, xOff: double, yOff: double, zOff: double)` — Applies an affine transformation to a geometry.

#### Dimension forcing

- **ST_Force2D** — `geometry ST_Force2D(geom: geometry)` — Forces a geometry into a XY coordinate model.
- **ST_Force3D** — `geometry ST_Force3D(geom: geometry)` · `geometry ST_Force3D(geom: geometry, z: double)` — Forces a geometry into a XYZ coordinate model with an optional Z value.
- **ST_Force3DM** — `geometry ST_Force3DM(geom: geometry)` · `geometry ST_Force3DM(geom: geometry, m: double)` — Forces a geometry into a XYM coordinate model with an optional M value.
- **ST_Force4D** — `geometry ST_Force4D(geom: geometry)` · `geometry ST_Force4D(geom: geometry, z: double)` · `geometry ST_Force4D(geom: geometry, z: double, m: double)` — Forces a geometry into a XYZM coordinate model with optional Z and M values.

#### Aggregates

- **ST_Collect_Agg** — `geometry ST_Collect_Agg(geom: geometry)` — Combines multiple geometries from a set of rows into a single collection.
- **ST_Envelope_Agg** — `geometry ST_Envelope_Agg(geom: geometry)` — Returns the collective bounding box (envelope) of a set of geometries.
- **ST_Analyze_Agg** — `struct ST_Analyze_Agg(geom: geometry)` — Computes statistics of geometries for the input geometry.

### Geo functions (always available)

10 scalar + 2 aggregate functions from the pure-Rust `geo` crate.

#### Measurement

- **ST_Area** — `double ST_Area(geom: geometry)` — Returns the area of a geometry.
- **ST_Length** — `double ST_Length(geom: geometry)` — Returns the length of a geometry.
- **ST_Perimeter** — `double ST_Perimeter(geom: geometry)` — Calculates the 2D perimeter of a given geometry.
- **ST_Distance** — `double ST_Distance(geomA: geometry, geomB: geometry)` — Returns the distance between two geometries or geographies.
- **ST_DWithin** — `boolean ST_DWithin(geomA: geometry, geomB: geometry, distance: double)` — Returns true if two geometries are within a specified distance of each other.

#### Geometry operations

- **ST_Buffer** — `geometry ST_Buffer(geom: geometry, distance: float64)` · `geometry ST_Buffer(geom: geometry, distance: float64, params: string)` — Computes a geometry representing all points within a specified distance.
- **ST_Centroid** — `geometry ST_Centroid(geom: geometry)` — Returns the centroid of a geometry.
- **ST_Intersects** — `boolean ST_Intersects(geomA: geometry, geomB: geometry)` — Returns true if geomA intersects geomB.
- **ST_LineInterpolatePoint** — `geometry ST_LineInterpolatePoint(geom: geometry, fraction: double)` — Returns a point interpolated along a line.

#### Serializers

- **ST_AsGeoJSON** — `string ST_AsGeoJSON(geom: geometry)` — Returns the GeoJSON representation of a geometry.

#### Aggregates

- **ST_Intersection_Agg** — `geometry ST_Intersection_Agg(geom: geometry)` — Returns the cumulative intersection of all geometries in the input.
- **ST_Union_Agg** — `geometry ST_Union_Agg(geom: geometry)` — Returns a geometry representing the point set union of all geometries.

### GEOS functions (`minimal`, `standard`, `global`, `full`)

42 scalar + 1 aggregate function via GEOS 3.13.1 (C++ cross-compiled with Emscripten).

#### Spatial predicates

- **ST_Contains** — `boolean ST_Contains(geomA: geometry, geomB: geometry)` — Returns true if geomA contains geomB.
- **ST_Within** — `boolean ST_Within(geomA: geometry, geomB: geometry)` — Returns true if A is completely inside B.
- **ST_Covers** — `boolean ST_Covers(geomA: geometry, geomB: geometry)` — Returns true if geomA covers geomB.
- **ST_CoveredBy** — `boolean ST_CoveredBy(geomA: geometry, geomB: geometry)` — Returns true if geomA is covered by geomB.
- **ST_Crosses** — `boolean ST_Crosses(geomA: geometry, geomB: geometry)` — Returns true if A crosses B.
- **ST_Touches** — `boolean ST_Touches(geomA: geometry, geomB: geometry)` — Returns true if A touches B.
- **ST_Overlaps** — `boolean ST_Overlaps(geomA: geometry, geomB: geometry)` — Returns true if A overlaps B.
- **ST_Disjoint** — `boolean ST_Disjoint(geomA: geometry, geomB: geometry)` — Returns true if geomA is disjoint from geomB.
- **ST_Equals** — `boolean ST_Equals(geomA: geometry, geomB: geometry)` — Returns true if geomA equals geomB.
- **ST_Relate** — `string ST_Relate(geomA: geometry, geomB: geometry)` · `boolean ST_Relate(geomA: geometry, geomB: geometry, intersectionMatrixPattern: string)` — Returns the DE-9IM intersection matrix string, or tests a given pattern.

#### Validation

- **ST_IsValid** — `boolean ST_IsValid(geom: geometry)` — Checks whether a geometry meets OGC validity rules.
- **ST_IsValidReason** — `string ST_IsValidReason(geom: geometry)` — Returns a text explanation describing why a geometry is invalid.
- **ST_IsSimple** — `boolean ST_IsSimple(geom: geometry)` — Tests if the geometry's only self-intersections are at boundary points.
- **ST_IsRing** — `boolean ST_IsRing(geom: geometry)` — Returns true if a linestring is `ST_IsClosed` and `ST_IsSimple`.
- **ST_MakeValid** — `geometry ST_MakeValid(geom: geometry)` · `geometry ST_MakeValid(geom: geometry, keepCollapsed: boolean)` — Creates a valid representation of an invalid geometry.

#### Overlay operations

- **ST_Intersection** — `geometry ST_Intersection(geomA: geometry, geomB: geometry)` · `geography ST_Intersection(geogA: geography, geogB: geography)` — Computes the intersection of two geometries or geographies.
- **ST_Union** — `geometry ST_Union(geomA: geometry, geomB: geometry)` — Returns a geometry that represents the point set union of two geometries.
- **ST_Difference** — `geometry ST_Difference(geomA: geometry, geomB: geometry)` — Computes the difference between geomA and geomB.
- **ST_SymDifference** — `geometry ST_SymDifference(geomA: geometry, geomB: geometry)` — Returns the parts of geometries A and B that do not overlap.

#### Hulls

- **ST_ConvexHull** — `geometry ST_ConvexHull(geom: geometry)` — Returns the Convex Hull of polygon A.
- **ST_ConcaveHull** — `geometry ST_ConcaveHull(geom: geometry, pct_convex: double)` — Returns a concave hull enclosing the input geometry.

#### Simplification

- **ST_Simplify** — `geometry ST_Simplify(geom: geometry, tolerance: double)` — Simplifies an input geometry using the Douglas-Peucker algorithm.
- **ST_SimplifyPreserveTopology** — `geometry ST_SimplifyPreserveTopology(geom: geometry, tolerance: double)` — Simplifies a geometry, ensuring the result is valid with the same topology.

#### Topology

- **ST_Boundary** — `geometry ST_Boundary(geom: geometry)` — Returns the closure of the combinatorial boundary of this geometry.
- **ST_UnaryUnion** — `geometry ST_UnaryUnion(geom: geometry)` — Returns a single geometry which is the union of all components.
- **ST_LineMerge** — `geometry ST_LineMerge(geom: geometry)` — Merges a collection of line segments into the fewest possible LineStrings.
- **ST_Polygonize** — `geometry ST_Polygonize(geom: geometry)` — Builds a polygonal geometry from linear components in the input geometry.
- **ST_Snap** — `geometry ST_Snap(geomA: geometry, geomB: geometry, tolerance: double)` — Snaps input geometry to reference geometry within tolerance.

#### Precision

- **ST_MinimumClearance** — `double ST_MinimumClearance(geom: geometry)` — Returns the minimum clearance of a geometry.
- **ST_MinimumClearanceLine** — `geometry ST_MinimumClearanceLine(geom: geometry)` — Returns a LineString representing the minimum clearance distance of the input geometry.

#### Properties

- **ST_NRings** — _(local runtime helper)_ returns the number of rings (interior + exterior) in a polygon.
- **ST_NumInteriorRings** — _(local runtime helper)_ returns the number of interior rings of a polygon.
- **ST_NumPoints** — _(local runtime helper)_ returns the number of points in a geometry.

#### Aggregates

- **ST_Polygonize_Agg** — `geometry ST_Polygonize_Agg(geom: geometry)` — Creates polygons from a set of geometries containing linework representing polygon edges.

### PROJ functions (`standard`, `global`, `full`)

1 scalar function via PROJ 9.6.0 (C++ cross-compiled with Emscripten).

- **ST_Transform** — `geometry ST_Transform(geom: geometry, target_crs: string)` · `geometry ST_Transform(geom: geometry, source_crs: string, target_crs: string)` — Transforms a geometry from one CRS to another. Supports EPSG codes, PROJ strings, and WKT2.

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
