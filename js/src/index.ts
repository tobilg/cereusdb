import init, { CereusDB as WasmCereusDB } from '../../pkg/cereusdb.js';

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
}

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

  /** Drop a table. */
  dropTable(name: string): void {
    this.inner.drop_table(name);
  }

  /** List registered tables. */
  tables(): string[] {
    return this.inner.tables();
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
