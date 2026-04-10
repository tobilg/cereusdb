# CereusDB API Documentation

Typedoc site for the public browser-facing TypeScript API exposed by the CereusDB npm packages.

The generated documentation covers:

- `CereusDB`
- `CereusDBOptions`
- `RasterFormat`
- `QueryResult`

The runtime SQL surface differs by package:

- `@cereusdb/minimal`: core + `geo` + GEOS + spatial joins / `ST_KNN`
- `@cereusdb/standard`: `minimal` + `ST_Transform`
- `@cereusdb/global`: `standard` + S2 geography kernels
- `@cereusdb/full`: `global` + raster `RS_*`

See the bundled guides for package selection and quick start usage.
