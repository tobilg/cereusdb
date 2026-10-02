# @cereusdb/full

Maximum-feature CereusDB browser package. Everything in `@cereusdb/global`, plus GDAL-backed raster ingestion and the full current `RS_*` runtime catalog.

This package includes browser object stores for ranged remote Parquet reads and S3/GCS/Azure/HTTP providers.

## Install

```bash
npm install @cereusdb/full
```

## Parquet support

Parquet files compressed with Snappy, Gzip, Brotli, LZ4, or ZSTD can be registered.

## SQL function availability

Current runtime surface:

- `155` runtime `ST_*` names
- `57` runtime `RS_*` names

Included function families:

- Everything from `@cereusdb/global`: core SedonaDB functions, `geo` functions, GEOS predicates/operations, `ST_Transform`, S2 geography kernels, relation joins, distance joins, and `ST_KNN`.
- Raster registration through the host API, the core SedonaDB raster catalog, and the GDAL-backed raster functions from `sedona-raster-gdal`.

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

GDAL-backed raster functions:

- `RS_AsGeoTiff`, `RS_FromGDALRaster` (GeoTIFF encode/decode)
- `RS_AsRaster`, `RS_Clip`, `RS_Polygonize`
- `RS_Resample`, `RS_ReprojectMatch`, `RS_Tile`
- `RS_MetaData`, `RS_ZonalStats`, `RS_ZonalStatsAll`

Raster ingestion notes:

- `registerGeoTIFF()` and `registerRaster()` are supported in this package.
- `registerFile()` supports `.tif` and `.tiff` in addition to Parquet and GeoJSON.
- The current browser raster path is host-driven. `RS_FromPath` is not exposed because the browser build has no local filesystem or GDAL network access; fetch the bytes in JavaScript and call `registerGeoTIFF()`.
- The bundled GDAL includes the GeoTIFF, MEM and VRT raster drivers, so `RS_FromGDALRaster` decodes GeoTIFF (including COG) only.
- Supported GeoTIFF compressions: None, Deflate, LZW, PackBits, JPEG, LERC, LERC_DEFLATE, ZSTD, and LERC_ZSTD. Other codecs (LZMA, WebP, JPEG XL) raise an error naming the missing codec.
- See the [raster functions guide](https://github.com/tobilg/cereusdb/blob/main/packages/documentation/guides/raster-functions.md) for details.

## Object storage support

Browser object stores are included in `@cereusdb/full`. Use `registerObjectStores()` to configure `http`, `s3`, `gcs`, or `azure` providers, then `registerParquetTable()` to register an exact Parquet object or provider-backed prefix.

## Loading the WASM module

The wasm binary ships as a separate file, `dist/wasm/cereusdb_bg.wasm`. The default entry finds it automatically, and bundlers emit it as an asset.

If you host the wasm yourself, or your bundler inlines assets into large `data:application/wasm;base64,...` strings, use the `external` entry. It has no built-in wasm reference and requires `wasmUrl` or `wasmSource`:

```ts
import { CereusDB } from '@cereusdb/full/external';

const db = await CereusDB.create({ wasmUrl: '/wasm/cereusdb_bg.wasm' });
```

Copy `node_modules/@cereusdb/full/dist/wasm/cereusdb_bg.wasm` to your static assets, or import its URL with Vite: `import wasmUrl from '@cereusdb/full/wasm?url'`. See the [WASM loading guide](https://github.com/tobilg/cereusdb/blob/main/packages/documentation/guides/wasm-loading.md) for details.

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
- `registerFile()` supports `.parquet`, `.geoparquet`, `.geojson`, `.json`, `.tif`, and `.tiff`.
- `registerObjectStores()` and `registerParquetTable()` support browser-backed ranged Parquet reads for `http`, `s3`, `gcs`, and `azure` providers.
- S3 temporary credentials use `access_key_id`, `secret_access_key`, and `token`, where `token` is the STS `SessionToken`.
- S3-compatible endpoints can be configured with `endpoint`; use `allow_http: true` for local HTTP endpoints such as MinIO or LocalStack.
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
