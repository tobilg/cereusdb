# @cereusdb/standard

Standard CereusDB browser package. Everything in `@cereusdb/minimal`, plus PROJ-backed `ST_Transform` and CRS-aware reprojection support.

This package includes browser object stores for ranged remote Parquet reads and S3/GCS/Azure/HTTP providers.

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

## Object storage support

Browser object stores are included in `@cereusdb/standard`. Use `registerObjectStores()` to configure `http`, `s3`, `gcs`, or `azure` providers, then `registerParquetTable()` to register an exact Parquet object or provider-backed prefix.

## JS / TS API

Exports:

- `CereusDB`
- `CereusDBOptions`
- `ObjectStoreRegistryConfig`
- `ObjectStoreConfig`
- `ObjectStoreProvider`
- `RegisterParquetTableOptions`
- `RasterFormat`
- `QueryResult`

Main types:

```ts
type RasterFormat = 'geotiff' | 'tiff';
type ObjectStoreProvider = 'http' | 's3' | 'gcs' | 'azure';

interface CereusDBOptions {
  wasmUrl?: string;
  wasmSource?:
    | RequestInfo
    | URL
    | Response
    | BufferSource
    | WebAssembly.Module
    | Promise<Response>;
  objectStores?: ObjectStoreRegistryConfig;
}

interface ObjectStoreRegistryConfig {
  maxConcurrency?: number;
  stores: ObjectStoreConfig[];
}

interface ObjectStoreConfig {
  name?: string;
  provider: ObjectStoreProvider;
  url: string;
  options?: Record<string, string | number | boolean>;
}

interface RegisterParquetTableOptions {
  fileExtension?: string;
  targetPartitions?: number;
}
```

Main API:

```ts
class CereusDB {
  static create(options?: CereusDBOptions): Promise<CereusDB>;
  sql(query: string): Promise<Uint8Array>;
  sqlJSON(query: string): Promise<Record<string, unknown>[]>;
  registerRemoteParquet(name: string, url: string): Promise<void>;
  registerObjectStores(config: ObjectStoreRegistryConfig): void;
  registerParquetTable(
    name: string,
    url: string,
    options?: RegisterParquetTableOptions,
  ): Promise<void>;
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
- `registerObjectStores()` and `registerParquetTable()` support browser-backed ranged Parquet reads for `http`, `s3`, `gcs`, and `azure` providers.
- S3 temporary credentials use `access_key_id`, `secret_access_key`, and `token`, where `token` is the STS `SessionToken`.
- S3-compatible endpoints can be configured with `endpoint`; use `allow_http: true` for local HTTP endpoints such as MinIO or LocalStack.
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
