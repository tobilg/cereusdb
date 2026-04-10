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
}

export type RasterFormat = 'geotiff' | 'tiff';

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
    return new CereusDB(inner);
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
}
