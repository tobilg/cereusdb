# Package Selection

## `@cereusdb/minimal`

Use this when you need the smallest browser package with:

- core SedonaDB vector SQL
- `geo` measurements and buffering
- GEOS predicates and topology
- relation joins, distance joins, and `ST_KNN`

Not included:

- `ST_Transform`
- S2 geography kernels
- raster `RS_*`

## `@cereusdb/standard`

Use this when you need everything in `minimal`, plus:

- `ST_Transform`
- CRS-aware reprojection through PROJ

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
