# CereusDB API Documentation

Typedoc site for the public browser-facing TypeScript API exposed by the CereusDB npm packages.

The generated documentation covers:

- `CereusDB`
- `CereusDBOptions`
- `ObjectStoreRegistryConfig`
- `ObjectStoreConfig`
- `ObjectStoreProvider`
- `RegisterParquetTableOptions`
- `RasterFormat`
- `QueryResult`
- Persistent databases: `StorageBackend`, `StorageOptions`, `MemoryStorageBackend`, `OPFSStorageBackend`, `CreateDatabaseOptions`, `AttachDatabaseOptions`, `DatabaseListing`
- Catalog and tables: `CatalogDatabase`, `CatalogSchema`, `CatalogTable`, `CatalogColumn`, `CreateTableDefinition`, `CreateTableOptions`, `AlterTableOperation`
- Export: `GeoParquetExportOptions`, `DownloadGeoParquetOptions`, `ExportHandler`, `downloadFile`, `PARQUET_MIME_TYPE`

The runtime SQL surface differs by package:

- `@cereusdb/minimal`: core + `geo` + GEOS + spatial joins / `ST_KNN`
- `@cereusdb/standard`: `minimal` + `ST_Transform` + browser object stores
- `@cereusdb/global`: `standard` + S2 geography kernels
- `@cereusdb/full`: `global` + raster `RS_*`

Browser object-store support is available in `@cereusdb/standard`, `@cereusdb/global`, and `@cereusdb/full`. It is not included in `@cereusdb/minimal`.

Persistent databases (`opfs://`), `ALTER TABLE`, and GeoParquet export (including `COPY ... TO`) are available in all four packages.

See the bundled guides for quick start usage, package selection, browser object stores, persistent databases, GeoParquet export, WASM loading, and raster functions.
