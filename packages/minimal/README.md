# @cereusdb/minimal

Smallest public CereusDB browser package. Includes the shared browser API, GEOS-backed spatial SQL, relation joins, distance joins, and `ST_KNN` in the current in-memory browser MVP.

## Install

```bash
npm install @cereusdb/minimal
```

## SQL function availability

Current runtime surface:

- `130` runtime `ST_*` names
- `0` runtime `RS_*` names

Included function families:

- Core SedonaDB scalar and aggregate functions from the pure-Rust runtime: constructors, WKT/WKB/EWKT/EWKB parsing, serializers, coordinate accessors, bounding-box helpers, SRID/CRS helpers, geometry properties, component access, affine transforms, and aggregates such as `ST_Collect_Agg`.
- `geo` functions such as `ST_Area`, `ST_Length`, `ST_Perimeter`, `ST_Distance`, `ST_DWithin`, `ST_Buffer`, `ST_Centroid`, `ST_Intersects`, `ST_LineInterpolatePoint`, `ST_AsGeoJSON`, `ST_Intersection_Agg`, and `ST_Union_Agg`.
- GEOS-backed predicates and operations such as `ST_Contains`, `ST_Within`, `ST_Covers`, `ST_CoveredBy`, `ST_Crosses`, `ST_Touches`, `ST_Overlaps`, `ST_Disjoint`, `ST_Equals`, `ST_Relate`, `ST_Intersection`, `ST_Union`, `ST_Difference`, `ST_SymDifference`, `ST_ConvexHull`, `ST_ConcaveHull`, `ST_Simplify`, `ST_Boundary`, `ST_UnaryUnion`, `ST_LineMerge`, `ST_Polygonize`, `ST_Snap`, `ST_MakeValid`, `ST_IsValid`, and `ST_IsValidReason`.
- Spatial join MVP support for relation joins, distance joins, and `ST_KNN`.

Not included in this package:

- `ST_Transform`
- S2 geography kernels
- Raster `RS_*` functions

## JS / TS API

Exports:

- `CereusDB`
- `CereusDBOptions`
- `RasterFormat`
- `QueryResult`

Main types:

```ts
type RasterFormat = 'geotiff' | 'tiff';

interface CereusDBOptions {
  wasmUrl?: string;
  wasmSource?:
    | RequestInfo
    | URL
    | Response
    | BufferSource
    | WebAssembly.Module
    | Promise<Response>;
}
```

Main API:

```ts
class CereusDB {
  static create(options?: CereusDBOptions): Promise<CereusDB>;
  sql(query: string): Promise<Uint8Array>;
  sqlJSON(query: string): Promise<Record<string, unknown>[]>;
  registerRemoteParquet(name: string, url: string): Promise<void>;
  registerFile(name: string, file: File): Promise<void>;
  registerGeoJSON(name: string, geojson: string | object): void;
  registerRaster(name: string, data: BufferSource, format: RasterFormat): void;
  registerGeoTIFF(name: string, data: BufferSource): void;
  dropTable(name: string): void;
  tables(): string[];
  version(): string;
}
```

API notes:

- `sql()` returns Arrow IPC bytes as `Uint8Array`.
- `sqlJSON()` returns parsed JSON rows.
- `registerFile()` supports `.parquet`, `.geoparquet`, `.geojson`, and `.json` in this package.
- `registerRaster()` and `registerGeoTIFF()` are part of the shared wrapper, but raster registration requires `@cereusdb/full`.

## Example

```ts
import { CereusDB } from '@cereusdb/minimal';

const db = await CereusDB.create();

const rows = await db.sqlJSON(`
  SELECT ST_AsText(ST_Buffer(ST_Point(0, 0), 1.0)) AS geom
`);

console.log(rows);
```
