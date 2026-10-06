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

## Persistent databases (OPFS)

Tables normally live in memory. Persistent databases are stored in the browser's Origin Private File System and survive page reloads:

```ts
const db = await CereusDB.create({ attach: ['opfs://mydb'] }); // opens or creates mydb

await db.sqlJSON(`CREATE TABLE mydb.public.cities AS SELECT 1 AS id, 'Berlin' AS name, ST_Point(13.4, 52.5) AS geom`);
await db.sqlJSON(`INSERT INTO mydb.public.cities VALUES (2, 'Paris', ST_Point(2.35, 48.86))`);
await db.sqlJSON(`USE mydb`); // `cities` now resolves to mydb.public.cities
```

SQL: `CREATE DATABASE 'opfs://mydb'`, `ATTACH 'opfs://mydb' [AS name]`, `DETACH name`, `DROP DATABASE name`, `USE name`, `ALTER TABLE ... RENAME TO | ADD COLUMN | DROP COLUMN | RENAME COLUMN`, and `SELECT * FROM cereusdb_databases()`. Databases appear as catalogs in `information_schema` and `db.catalog()`. A table's data is loaded the first time it is used. See the [persistent databases guide](https://github.com/tobilg/cereusdb/blob/main/packages/documentation/guides/persistent-databases.md).

## GeoParquet export

```ts
const bytes = await db.exportGeoParquet('mydb.public.cities'); // Uint8Array
await db.downloadGeoParquet('mydb.public.cities');            // downloads cities.parquet
await db.sqlJSON(`COPY (SELECT * FROM cities WHERE id > 1) TO 'some.parquet'`);
```

See the [GeoParquet export guide](https://github.com/tobilg/cereusdb/blob/main/packages/documentation/guides/geoparquet-export.md).

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
- `MemoryStorageBackend`, `OPFSStorageBackend`, `StorageBackend`, `StorageOptions`
- `CreateDatabaseOptions`, `AttachDatabaseOptions`, `DatabaseListing`
- `CatalogDatabase`, `CatalogSchema`, `CatalogTable`, `CatalogColumn`
- `CreateTableDefinition`, `CreateTableOptions`, `AlterTableOperation`
- `GeoParquetExportOptions`, `DownloadGeoParquetOptions`, `ExportHandler`
- `downloadFile`, `PARQUET_MIME_TYPE`

Main types:

```ts
interface StorageOptions {
  opfs?: StorageBackend | false; // default: OPFSStorageBackend when the browser has OPFS
  [scheme: string]: StorageBackend | false | undefined;
}

interface StorageBackend {
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
  lock?(name: string): Promise<void>;
  unlock?(name: string): Promise<void>;
}

type ExportHandler = (filename: string, data: Uint8Array, mimeType: string) => void | Promise<void>;

type CreateTableDefinition = { columns: Record<string, string> } | { as: string };

type AlterTableOperation =
  | { renameTo: string }
  | { addColumn: { name: string; type: string; notNull?: boolean; default?: string }; ifNotExists?: boolean }
  | { dropColumn: string | string[]; ifExists?: boolean }
  | { renameColumn: { from: string; to: string } };

interface GeoParquetExportOptions {
  compression?: 'zstd' | 'snappy' | 'lz4' | 'gzip' | 'brotli' | 'uncompressed';
  rowGroupSize?: number;
}

interface DownloadGeoParquetOptions extends GeoParquetExportOptions {
  filename?: string;
}

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
  storage?: StorageOptions;
  attach?: string[];
  onExport?: ExportHandler | false;
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
  dropTable(name: string): Promise<void>;
  catalog(): Promise<CatalogDatabase[]>;
  createDatabase(location: string, options?: CreateDatabaseOptions): Promise<string>;
  attachDatabase(location: string, options?: AttachDatabaseOptions): Promise<string>;
  detachDatabase(name: string, options?: { ifExists?: boolean }): Promise<void>;
  dropDatabase(nameOrLocation: string, options?: { ifExists?: boolean }): Promise<void>;
  useDatabase(database: string, schema?: string): Promise<void>;
  listDatabases(): Promise<DatabaseListing[]>;
  createTable(name: string, definition: CreateTableDefinition, options?: CreateTableOptions): Promise<void>;
  alterTable(name: string, operation: AlterTableOperation): Promise<void>;
  insertArrow(table: string, data: BufferSource): Promise<number>;
  compactDatabase(name: string): Promise<void>;
  flush(): Promise<void>;
  exportGeoParquet(queryOrTable: string, options?: GeoParquetExportOptions): Promise<Uint8Array>;
  downloadGeoParquet(queryOrTable: string, options?: DownloadGeoParquetOptions): Promise<string>;
  tables(options?: { qualified?: boolean }): string[];
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
- Persistent databases (`createDatabase()` and related methods), `ALTER TABLE`, `insertArrow()`, `catalog()` and GeoParquet export are available in every package.
- `downloadGeoParquet()` and `COPY ... TO` pass the file to the `onExport` handler: a browser download by default on the main thread; pass your own handler in Web Workers or Node.js.

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
