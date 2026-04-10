# @cereusdb/full

Maximum-feature CereusDB browser package. Everything in `@cereusdb/global`, plus GDAL-backed raster ingestion and the full current `RS_*` runtime catalog.

## Install

```bash
npm install @cereusdb/full
```

## SQL function availability

Current runtime surface:

- `132` runtime `ST_*` names
- `33` runtime `RS_*` names

Included function families:

- Everything from `@cereusdb/global`: core SedonaDB functions, `geo` functions, GEOS predicates/operations, `ST_Transform`, S2 geography kernels, relation joins, distance joins, and `ST_KNN`.
- Raster registration through the host API and the full current browser raster catalog.

Examples of available raster functions:

- `RS_Width`
- `RS_Height`
- `RS_NumBands`
- `RS_BandPixelType`
- `RS_CRS`
- `RS_GeoReference`
- `RS_PixelAsPoint`
- `RS_PixelAsPolygon`
- `RS_Contains`
- `RS_Intersects`
- `RS_Within`

Raster ingestion notes:

- `registerGeoTIFF()` and `registerRaster()` are supported in this package.
- `registerFile()` supports `.tif` and `.tiff` in addition to Parquet and GeoJSON.
- The current browser raster path is host-driven; SQL-side raster loader functions are not exposed.

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
- `registerFile()` supports `.parquet`, `.geoparquet`, `.geojson`, `.json`, `.tif`, and `.tiff`.
- `registerRaster()` currently accepts `geotiff` and `tiff`.

## Example

```ts
import { CereusDB } from '@cereusdb/full';

const db = await CereusDB.create();

db.registerGeoTIFF('raster', bytes);

const rows = await db.sqlJSON(`
  SELECT RS_Width(raster) AS width, RS_Height(raster) AS height
  FROM raster
`);

console.log(rows);
```
