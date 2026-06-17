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

The runtime SQL surface differs by package:

- `@cereusdb/minimal`: core + `geo` + GEOS + spatial joins / `ST_KNN`
- `@cereusdb/standard`: `minimal` + `ST_Transform` + browser object stores
- `@cereusdb/global`: `standard` + S2 geography kernels
- `@cereusdb/full`: `global` + raster `RS_*`

Browser object-store support is available in `@cereusdb/standard`, `@cereusdb/global`, and `@cereusdb/full`. It is not included in `@cereusdb/minimal`.

See the bundled guides for package selection, browser object stores, and quick start usage.
