# Package Selection

## Browser object stores

Browser object stores are included in:

- `@cereusdb/standard`
- `@cereusdb/global`
- `@cereusdb/full`

They are not included in `@cereusdb/minimal`. Use `standard` or larger when you need ranged remote Parquet reads or S3/GCS/Azure/HTTP object-store providers.

## `@cereusdb/minimal`

Use this when you need the smallest browser package with:

- core SedonaDB vector SQL
- `geo` measurements and buffering
- GEOS predicates and topology
- relation joins, distance joins, and `ST_KNN`

Not included:

- browser object stores
- `ST_Transform`
- S2 geography kernels
- raster `RS_*`

## `@cereusdb/standard`

Use this when you need everything in `minimal`, plus:

- `ST_Transform`
- CRS-aware reprojection through PROJ
- browser object stores for ranged remote Parquet reads and S3/GCS/Azure/HTTP providers

## `@cereusdb/global`

Use this when you need everything in `standard`, plus:

- spherical geography operations through S2
- geography distance/area/length/perimeter
- geography overlay and nearest/linear-reference helpers

## `@cereusdb/full`

Use this when you need everything in `global`, plus:

- GDAL-backed raster ingestion
- the current browser `RS_*` catalog
- raster predicates like `RS_Contains`, `RS_Intersects`, and `RS_Within`
