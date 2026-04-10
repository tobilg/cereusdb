# @cereusdb/global

Global CereusDB browser package. Everything in `@cereusdb/standard`, plus the opt-in S2 geography kernel family for spherical lon/lat geography operations.

## Install

```bash
npm install @cereusdb/global
```

## SQL function availability

Current runtime surface:

- `132` runtime `ST_*` names
- `0` runtime `RS_*` names

Included function families:

- Everything from `@cereusdb/standard`: core SedonaDB functions, `geo` functions, GEOS predicates/operations, `ST_Transform`, relation joins, distance joins, and `ST_KNN`.
- S2 geography kernels and the S2-backed `sd_order` override for lon/lat geography values.

Examples of S2-enabled geography functions:

- `ST_Area`
- `ST_Distance`
- `ST_Length`
- `ST_Perimeter`
- `ST_Contains`
- `ST_Intersects`
- `ST_Equals`
- `ST_Intersection`
- `ST_Difference`
- `ST_Union`
- `ST_SymDifference`
- `ST_ConvexHull`
- `ST_Centroid`
- `ST_ClosestPoint`
- `ST_LineInterpolatePoint`
- `ST_LineLocatePoint`
- `ST_MaxDistance`
- `ST_ShortestLine`

Not included in this package:

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
import { CereusDB } from '@cereusdb/global';

const db = await CereusDB.create();

const rows = await db.sqlJSON(`
  SELECT ST_Distance(
    ST_GeogFromWKT('POINT(0 0)'),
    ST_GeogFromWKT('POINT(1 0)')
  ) AS meters
`);

console.log(rows);
```
