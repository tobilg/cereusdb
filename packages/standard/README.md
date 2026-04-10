# @cereusdb/standard

Standard CereusDB browser package. Everything in `@cereusdb/minimal`, plus PROJ-backed `ST_Transform` and CRS-aware reprojection support.

## Install

```bash
npm install @cereusdb/standard
```

## SQL function availability

Current runtime surface:

- `131` runtime `ST_*` names
- `0` runtime `RS_*` names

Included function families:

- Everything from `@cereusdb/minimal`: core SedonaDB functions, `geo` functions, GEOS predicates/operations, relation joins, distance joins, and `ST_KNN`.
- PROJ-backed CRS transformation with `ST_Transform`.

Examples of available functions:

- Core and `geo`: `ST_Point`, `ST_GeomFromWKT`, `ST_AsText`, `ST_SRID`, `ST_Buffer`, `ST_Distance`, `ST_DWithin`, `ST_AsGeoJSON`
- GEOS: `ST_Contains`, `ST_Within`, `ST_Crosses`, `ST_Touches`, `ST_Union`, `ST_Difference`, `ST_MakeValid`, `ST_Polygonize`
- PROJ: `ST_Transform`

Not included in this package:

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
import { CereusDB } from '@cereusdb/standard';

const db = await CereusDB.create();

const rows = await db.sqlJSON(`
  SELECT ST_AsText(
    ST_Transform(
      ST_GeomFromWKT('POINT(13.4 52.5)'),
      'EPSG:4326',
      'EPSG:3857'
    )
  ) AS geom
`);

console.log(rows);
```
