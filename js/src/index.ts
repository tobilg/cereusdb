import init, { CereusDB as WasmCereusDB } from '../../pkg/cereusdb.js';
import { OPFSStorageBackend, type StorageBackend } from './storage.js';

export {
  MemoryStorageBackend,
  OPFSStorageBackend,
  type OPFSStorageBackendOptions,
  type StorageBackend,
} from './storage.js';

export interface QueryResult {
  /** Raw JSON data parsed from query */
  data: Record<string, unknown>[];
  /** Number of rows */
  numRows: number;
  /** Raw Arrow IPC bytes */
  toIPC(): Uint8Array;
  /** Convert to array of plain JS objects */
  toJSON(): Record<string, unknown>[];
}

export interface CereusDBOptions {
  /** Custom WASM module URL (for CDN hosting) */
  wasmUrl?: string;
  /** Preloaded WASM bytes/module for Node or custom loaders. */
  wasmSource?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module | Promise<Response>;
  /** Browser-backed object stores to register at startup. */
  objectStores?: ObjectStoreRegistryConfig;
  /**
   * Storage backends for persistent databases, by URL scheme. `opfs` defaults
   * to an {@link OPFSStorageBackend} when the browser supports OPFS; pass
   * `false` to disable it.
   */
  storage?: StorageOptions;
  /**
   * Persistent databases to open at startup, for example `['opfs://mydb']`.
   * Each is created if it does not exist yet.
   */
  attach?: string[];
  /**
   * Receives files written by `COPY ... TO '<file>'` and
   * {@link CereusDB.downloadGeoParquet}. Defaults to {@link downloadFile}
   * (a browser download) when a DOM `document` is available; pass `false` to
   * disable exports or a function to handle them yourself (for example in a
   * Web Worker or in Node.js).
   */
  onExport?: ExportHandler | false;
}

/** Receives an exported file. */
export type ExportHandler = (
  filename: string,
  data: Uint8Array,
  mimeType: string,
) => void | Promise<void>;

/** MIME type of GeoParquet exports. */
export const PARQUET_MIME_TYPE = 'application/vnd.apache.parquet';

/**
 * Save a file with the browser's download mechanism. Needs a DOM `document`
 * (the main thread); it does not work in Web Workers or Node.js.
 */
export function downloadFile(
  filename: string,
  data: Uint8Array,
  mimeType = 'application/octet-stream',
): void {
  if (typeof document === 'undefined') {
    throw new Error(
      'downloadFile() needs a browser document; pass CereusDB.create({ onExport }) to handle exports elsewhere',
    );
  }
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Revoking right away can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export interface StorageOptions {
  opfs?: StorageBackend | false;
  [scheme: string]: StorageBackend | false | undefined;
}

export interface CreateDatabaseOptions {
  /** Database (catalog) name. Defaults to the lowercased name in the location URL. */
  name?: string;
  /** Open the database if it already exists instead of failing. */
  ifNotExists?: boolean;
}

export interface AttachDatabaseOptions {
  /** Database (catalog) name. Defaults to the lowercased name in the location URL. */
  name?: string;
  /** Succeed if the database is already attached under this name. */
  ifNotExists?: boolean;
}

export interface DatabaseListing {
  /** Catalog name, or `null` for stored databases that are not attached. */
  name: string | null;
  /** `memory` or the storage scheme, for example `opfs`. */
  storage: string;
  /** Location URL for persistent databases. */
  location: string | null;
  attached: boolean;
}

export interface CatalogColumn {
  name: string;
  /** Arrow data type. */
  type: string;
  nullable: boolean;
  /** Arrow extension type, for example `geoarrow.wkb` for geometry columns. */
  extension?: string;
}

export interface CatalogTable {
  name: string;
  type: 'BASE TABLE' | 'VIEW' | 'LOCAL TEMPORARY';
  columns: CatalogColumn[];
}

export interface CatalogSchema {
  name: string;
  tables: CatalogTable[];
}

export interface CatalogDatabase {
  name: string;
  storage: string;
  location: string | null;
  schemas: CatalogSchema[];
}

/** Columns as `{ name: 'SQL type' }`, or a query for CREATE TABLE ... AS. */
export type CreateTableDefinition = { columns: Record<string, string> } | { as: string };

export interface GeoParquetExportOptions {
  /** Parquet compression codec. Defaults to `zstd`. */
  compression?: 'zstd' | 'snappy' | 'lz4' | 'gzip' | 'brotli' | 'uncompressed';
  /** Maximum number of rows per row group. */
  rowGroupSize?: number;
}

export interface DownloadGeoParquetOptions extends GeoParquetExportOptions {
  /**
   * File name. Defaults to `<table>.parquet` for a table and
   * `export.parquet` for a query.
   */
  filename?: string;
}

export interface CreateTableOptions {
  ifNotExists?: boolean;
  orReplace?: boolean;
}

export type AlterTableOperation =
  | { renameTo: string }
  | {
      addColumn: {
        name: string;
        /** SQL type, for example `VARCHAR` or `DOUBLE`. */
        type: string;
        notNull?: boolean;
        /** SQL expression used for existing rows and as column default. */
        default?: string;
      };
      ifNotExists?: boolean;
    }
  | { dropColumn: string | string[]; ifExists?: boolean }
  | { renameColumn: { from: string; to: string } };

export type RasterFormat = 'geotiff' | 'tiff';
export type ObjectStoreProvider = 'http' | 's3' | 'gcs' | 'azure';

export interface ObjectStoreRegistryConfig {
  /** Maximum concurrent browser fetches used by object_store. */
  maxConcurrency?: number;
  /** Stores registered by URL prefix. */
  stores: ObjectStoreConfig[];
}

export interface ObjectStoreConfig {
  /** Optional diagnostic name. */
  name?: string;
  /** Backing provider. */
  provider: ObjectStoreProvider;
  /** URL prefix, for example https://host, s3://bucket, gs://bucket. */
  url: string;
  /** Upstream object_store option keys and primitive values. */
  options?: Record<string, string | number | boolean>;
}

export interface RegisterParquetTableOptions {
  /** File extension used during listing discovery. Defaults to .parquet. */
  fileExtension?: string;
  /** Optional DataFusion target partition count. */
  targetPartitions?: number;
}

const QUERY_PATTERN = /^\s*(select|with|values|\()/i;

function resolveExportHandler(option?: ExportHandler | false): ExportHandler | undefined {
  if (option === false) {
    return undefined;
  }
  if (option !== undefined) {
    return option;
  }
  return typeof document !== 'undefined' ? downloadFile : undefined;
}

function defaultExportFilename(queryOrTable: string): string {
  if (QUERY_PATTERN.test(queryOrTable)) {
    return 'export.parquet';
  }
  const name = queryOrTable.trim().split('.').pop()?.replace(/^"|"$/g, '');
  return `${name || 'export'}.parquet`;
}

function resolveStorageBackends(options?: StorageOptions): Record<string, StorageBackend> {
  const backends: Record<string, StorageBackend> = {};
  for (const [scheme, backend] of Object.entries(options ?? {})) {
    if (backend) {
      backends[scheme.toLowerCase()] = backend;
    }
  }
  if (options?.opfs === undefined && OPFSStorageBackend.isSupported()) {
    backends.opfs = new OPFSStorageBackend();
  }
  return backends;
}

function alterTableClause(operation: AlterTableOperation): string {
  if ('renameTo' in operation) {
    return `RENAME TO ${operation.renameTo}`;
  }
  if ('addColumn' in operation) {
    const column = operation.addColumn;
    const notNull = column.notNull ? ' NOT NULL' : '';
    const defaultValue = column.default !== undefined ? ` DEFAULT ${column.default}` : '';
    const ifNotExists = operation.ifNotExists ? 'IF NOT EXISTS ' : '';
    return `ADD COLUMN ${ifNotExists}${column.name} ${column.type}${notNull}${defaultValue}`;
  }
  if ('dropColumn' in operation) {
    const columns = Array.isArray(operation.dropColumn)
      ? operation.dropColumn
      : [operation.dropColumn];
    const ifExists = operation.ifExists ? 'IF EXISTS ' : '';
    return columns.map((column) => `DROP COLUMN ${ifExists}${column}`).join(', ');
  }
  return `RENAME COLUMN ${operation.renameColumn.from} TO ${operation.renameColumn.to}`;
}

type WasmObjectStoreApi = {
  register_object_stores(config: ObjectStoreRegistryConfig): void;
  register_parquet_table(
    name: string,
    url: string,
    options?: RegisterParquetTableOptions,
  ): Promise<void>;
};

function toUint8Array(data: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  return new Uint8Array(data);
}

function normalizeRasterFormat(format: string): RasterFormat {
  const normalized = format.trim().toLowerCase();

  if (normalized === 'geotiff' || normalized === 'tiff') {
    return normalized;
  }

  throw new Error(`Unsupported raster format: ${format}`);
}

export class CereusDB {
  private inner: WasmCereusDB;
  private storageBackends: Record<string, StorageBackend> = {};
  private exportHandler?: ExportHandler;

  private constructor(inner: WasmCereusDB) {
    this.inner = inner;
  }

  /**
   * Create and initialize a new CereusDB instance.
   * This loads the WASM module and initializes the query engine.
   */
  static async create(options?: CereusDBOptions): Promise<CereusDB> {
    const source = options?.wasmSource ?? options?.wasmUrl;
    if (source === undefined) {
      await init();
    } else {
      await init({ module_or_path: source });
    }
    const inner = WasmCereusDB.create();
    const db = new CereusDB(inner);
    if (options?.objectStores !== undefined) {
      db.registerObjectStores(options.objectStores);
    }
    db.exportHandler = resolveExportHandler(options?.onExport);
    if (db.exportHandler !== undefined) {
      inner.register_export_handler(db.exportHandler);
    }
    db.storageBackends = resolveStorageBackends(options?.storage);
    for (const [scheme, backend] of Object.entries(db.storageBackends)) {
      inner.register_storage_backend(scheme, backend);
    }
    for (const location of options?.attach ?? []) {
      await db.createDatabase(location, { ifNotExists: true });
    }
    return db;
  }

  /**
   * Execute a SQL query and return results as Arrow IPC bytes.
   */
  async sql(query: string): Promise<Uint8Array> {
    return await this.inner.sql(query);
  }

  /**
   * Execute a SQL query and return results as JSON.
   */
  async sqlJSON(query: string): Promise<Record<string, unknown>[]> {
    const json = await this.inner.sql_json(query);
    return JSON.parse(json);
  }

  /**
   * Register a remote Parquet file as a table.
   * The server must support CORS.
   */
  async registerRemoteParquet(name: string, url: string): Promise<void> {
    await this.inner.register_remote_parquet(name, url);
  }

  /**
   * Register browser-backed object stores for ranged and listing reads.
   */
  registerObjectStores(config: ObjectStoreRegistryConfig): void {
    this.objectStoreApi().register_object_stores(config);
  }

  /**
   * Register a remote Parquet object or prefix through DataFusion's listing table path.
   */
  async registerParquetTable(
    name: string,
    url: string,
    options: RegisterParquetTableOptions = {},
  ): Promise<void> {
    await this.objectStoreApi().register_parquet_table(name, url, options);
  }

  /**
   * Register a local file (from File API / drag-and-drop) as a table.
   * Currently supports Parquet, GeoJSON, and GeoTIFF rasters.
   */
  async registerFile(name: string, file: File): Promise<void> {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'parquet' || ext === 'geoparquet') {
      await this.inner.register_parquet_buffer(name, buffer);
    } else if (ext === 'geojson' || ext === 'json') {
      const text = new TextDecoder().decode(buffer);
      this.inner.register_geojson(name, text);
    } else if (ext === 'tif' || ext === 'tiff') {
      this.registerRaster(name, buffer, 'geotiff');
    } else {
      throw new Error(`Unsupported file format: .${ext}`);
    }
  }

  /**
   * Register a GeoJSON object or string as a table.
   */
  registerGeoJSON(name: string, geojson: string | object): void {
    const str = typeof geojson === 'string' ? geojson : JSON.stringify(geojson);
    this.inner.register_geojson(name, str);
  }

  /**
   * Register a raster buffer as a single-column raster table.
   * Requires the full GDAL-enabled package build.
   */
  registerRaster(name: string, data: BufferSource, format: RasterFormat): void {
    this.inner.register_raster_buffer(name, normalizeRasterFormat(format), toUint8Array(data));
  }

  /**
   * Register a GeoTIFF buffer as a single-column raster table.
   * Requires the full GDAL-enabled package build.
   */
  registerGeoTIFF(name: string, data: BufferSource): void {
    this.registerRaster(name, data, 'geotiff');
  }

  /**
   * Drop a table. The table is removed immediately; for tables of persistent
   * databases the returned promise resolves once the change is written.
   */
  dropTable(name: string): Promise<void> {
    this.inner.drop_table(name);
    return this.inner.flush();
  }

  /**
   * Create a persistent database, for example `opfs://mydb`, and attach it
   * as a catalog. Equivalent to `CREATE DATABASE 'opfs://mydb'`.
   * Resolves to the database name.
   */
  async createDatabase(location: string, options: CreateDatabaseOptions = {}): Promise<string> {
    return await this.inner.attach_database(
      location,
      options.name,
      true,
      options.ifNotExists ?? false,
    );
  }

  /**
   * Open an existing persistent database. Equivalent to
   * `ATTACH 'opfs://mydb' [AS name]`. Resolves to the database name.
   */
  async attachDatabase(location: string, options: AttachDatabaseOptions = {}): Promise<string> {
    return await this.inner.attach_database(
      location,
      options.name,
      false,
      options.ifNotExists ?? false,
    );
  }

  /** Write pending changes and close a persistent database. Equivalent to `DETACH name`. */
  async detachDatabase(name: string, options: { ifExists?: boolean } = {}): Promise<void> {
    await this.inner.detach_database(name, options.ifExists ?? false);
  }

  /**
   * Drop a database by name or location. Persistent databases are deleted
   * from storage. Equivalent to `DROP DATABASE`.
   */
  async dropDatabase(nameOrLocation: string, options: { ifExists?: boolean } = {}): Promise<void> {
    await this.inner.drop_database(nameOrLocation, options.ifExists ?? false);
  }

  /** Set the default database (and schema). Equivalent to `USE database[.schema]`. */
  async useDatabase(database: string, schema?: string): Promise<void> {
    await this.inner.sql_json(schema === undefined ? `USE ${database}` : `USE ${database}.${schema}`);
  }

  /** Attached databases plus stored databases that are not attached. */
  async listDatabases(): Promise<DatabaseListing[]> {
    const rows = (await this.sqlJSON(
      'SELECT database_name, storage, location FROM cereusdb_databases()',
    )) as { database_name: string; storage: string; location: string | null }[];
    const databases: DatabaseListing[] = rows.map((row) => ({
      name: row.database_name,
      storage: row.storage,
      location: row.location ?? null,
      attached: true,
    }));
    for (const scheme of Object.keys(this.storageBackends)) {
      const locations = (await this.inner.list_database_locations(scheme)) as string[];
      for (const location of locations) {
        if (!databases.some((database) => database.location === location)) {
          databases.push({ name: null, storage: scheme, location, attached: false });
        }
      }
    }
    return databases;
  }

  /** Describe all databases, schemas, tables and views. */
  async catalog(): Promise<CatalogDatabase[]> {
    return JSON.parse(await this.inner.catalog_json());
  }

  /**
   * Create a table from column definitions or a query. `name` may be
   * qualified (`mydb.public.cities`).
   */
  async createTable(
    name: string,
    definition: CreateTableDefinition,
    options: CreateTableOptions = {},
  ): Promise<void> {
    const orReplace = options.orReplace ? 'OR REPLACE ' : '';
    const ifNotExists = options.ifNotExists ? 'IF NOT EXISTS ' : '';
    const body =
      'as' in definition
        ? `AS ${definition.as}`
        : `(${Object.entries(definition.columns)
            .map(([column, type]) => `${column} ${type}`)
            .join(', ')})`;
    await this.inner.sql_json(`CREATE ${orReplace}TABLE ${ifNotExists}${name} ${body}`);
  }

  /** Rename a table or add, drop, or rename a column. */
  async alterTable(name: string, operation: AlterTableOperation): Promise<void> {
    await this.inner.sql_json(`ALTER TABLE ${name} ${alterTableClause(operation)}`);
  }

  /**
   * Insert Arrow IPC data (stream or file format, for example from
   * `tableToIPC()` of apache-arrow) into a table. Columns are matched by
   * name; missing columns are filled with NULL. Resolves to the number of
   * inserted rows.
   */
  async insertArrow(table: string, data: BufferSource): Promise<number> {
    return await this.inner.insert_arrow(table, toUint8Array(data));
  }

  /**
   * Export a table or query result as a GeoParquet (1.1) file. Geometry and
   * geography columns are described in the file's `geo` metadata.
   *
   * @param queryOrTable A query (`SELECT ...`, `WITH ...`) or a table name.
   */
  async exportGeoParquet(
    queryOrTable: string,
    options: GeoParquetExportOptions = {},
  ): Promise<Uint8Array> {
    const query = QUERY_PATTERN.test(queryOrTable)
      ? queryOrTable
      : `SELECT * FROM ${queryOrTable}`;
    return await this.inner.export_geoparquet(query, options);
  }

  /**
   * Export a table or query result as GeoParquet and pass it to the export
   * handler: a browser download by default (see `onExport` in
   * {@link CereusDBOptions}). Resolves to the file name.
   *
   * @param queryOrTable A query (`SELECT ...`, `WITH ...`) or a table name.
   */
  async downloadGeoParquet(
    queryOrTable: string,
    options: DownloadGeoParquetOptions = {},
  ): Promise<string> {
    const { filename, ...exportOptions } = options;
    const handler = this.exportHandler;
    if (handler === undefined) {
      throw new Error(
        'No export handler: downloads need a browser document; pass CereusDB.create({ onExport }) elsewhere',
      );
    }
    const data = await this.exportGeoParquet(queryOrTable, exportOptions);
    const name = filename ?? defaultExportFilename(queryOrTable);
    await handler(name, data, PARQUET_MIME_TYPE);
    return name;
  }

  /** Rewrite all tables of a persistent database into one segment each. */
  async compactDatabase(name: string): Promise<void> {
    await this.inner.compact_database(name);
  }

  /** Write pending changes of persistent databases (for example after registerGeoJSON()). */
  async flush(): Promise<void> {
    await this.inner.flush();
  }

  /**
   * List the tables and views of all databases. By default only the table
   * names are returned, which is ambiguous when databases contain tables with
   * the same name; pass `{ qualified: true }` for `database.schema.table`
   * names, or use {@link CereusDB.catalog} for full details.
   */
  tables(options: { qualified?: boolean } = {}): string[] {
    return options.qualified ? this.inner.qualified_tables() : this.inner.tables();
  }

  /** Version string. */
  version(): string {
    return this.inner.version();
  }

  private objectStoreApi(): WasmObjectStoreApi {
    const api = this.inner as unknown as Partial<WasmObjectStoreApi>;
    if (
      typeof api.register_object_stores !== 'function' ||
      typeof api.register_parquet_table !== 'function'
    ) {
      throw new Error('Browser object stores are not available in this CereusDB build');
    }
    return api as WasmObjectStoreApi;
  }
}
