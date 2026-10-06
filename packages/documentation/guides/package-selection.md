# Package Selection

## Browser object stores

Browser object stores are included in:

- `@cereusdb/standard`
- `@cereusdb/global`
- `@cereusdb/full`

They are not included in `@cereusdb/minimal`. Use `standard` or larger when you need ranged remote Parquet reads or S3/GCS/Azure/HTTP object-store providers.

## Persistent databases and export

Persistent databases (`opfs://`), `ALTER TABLE`, `insertArrow()` and GeoParquet
export (`exportGeoParquet()`, `downloadGeoParquet()`, `COPY ... TO`) are
included in every package. Only exporting geometry with a CRS other than
OGC:CRS84 needs PROJ, which `@cereusdb/minimal` does not include.

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
- the current browser `RS_*` catalog, including GDAL-backed functions such as `RS_Clip`, `RS_Resample`, `RS_ReprojectMatch`, `RS_Polygonize`, `RS_ZonalStats` and `RS_AsGeoTiff` (see the raster functions guide)
- raster predicates like `RS_Contains`, `RS_Intersects`, and `RS_Within`
