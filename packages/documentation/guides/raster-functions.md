# Raster Functions

Raster support is available in `@cereusdb/full` only. It combines two sets of
SedonaDB functions:

- the core raster catalog from `sedona-raster-functions`: metadata, georeference,
  pixel geometry, band values and predicates such as `RS_Width`, `RS_CRS`,
  `RS_PixelAsPolygon` and `RS_Intersects`
- the GDAL-backed functions from `sedona-raster-gdal`, which run GDAL's
  algorithms (warp, rasterize, polygonize, GeoTIFF encoding) inside the
  WebAssembly module

## Loading rasters

Rasters enter SQL from the host side, as in-memory rasters:

```ts
const bytes = new Uint8Array(await (await fetch('/data/elevation.tif')).arrayBuffer());
db.registerGeoTIFF('elevation', bytes);

const rows = await db.sqlJSON('SELECT RS_Width(raster) AS width FROM elevation');
```

`registerFile()` accepts `.tif` and `.tiff` files from the File API as well.
Inside SQL, `RS_FromGDALRaster` decodes GeoTIFF bytes from a binary column or
expression.

## GDAL-backed functions

| Function | What it does |
| --- | --- |
| `RS_AsGeoTiff` | Encode a raster as GeoTIFF bytes |
| `RS_AsRaster` | Rasterize a geometry onto the grid of a reference raster |
| `RS_Clip` | Clip a raster to a geometry, setting outside pixels to nodata |
| `RS_FromGDALRaster` | Decode raster bytes (GeoTIFF in this build) into a raster |
| `RS_MetaData` | Return raster metadata as a struct |
| `RS_Polygonize` | Convert a band into polygons of connected pixel-value regions |
| `RS_ReprojectMatch` | Warp a raster onto the grid and CRS of another raster |
| `RS_Resample` | Resample onto a new pixel grid (size, pixel size or snapped origin) |
| `RS_Tile` | Split a raster into a grid of fixed-size tiles |
| `RS_ZonalStats` | Compute one statistic of a band within a geometry |
| `RS_ZonalStatsAll` | Compute all zonal statistics of a band within a geometry |

```sql
SELECT RS_ZonalStats(
  raster,
  ST_GeomFromText('POLYGON ((60 90, 160 90, 160 190, 60 190, 60 90))', 'OGC:CRS84'),
  1,
  'mean'
) AS mean_value
FROM elevation;
```

```sql
-- Round-trip through GeoTIFF bytes
SELECT RS_Width(RS_FromGDALRaster(RS_AsGeoTiff(raster))) FROM elevation;
```

## Browser limitations

- **Formats:** the WebAssembly GDAL build includes the GeoTIFF, MEM and VRT
  raster drivers. `RS_FromGDALRaster` and `RS_AsGeoTiff` therefore read and
  write GeoTIFF (including Cloud Optimized GeoTIFF); other formats such as PNG,
  JPEG files or NetCDF fail to decode.
- **GeoTIFF compression:** None, Deflate, LZW, PackBits, JPEG, LERC,
  LERC_DEFLATE, ZSTD and LERC_ZSTD are supported. Files using other codecs,
  such as LZMA, WebP or JPEG XL, are rejected with an error that names the
  missing codec.
- **`RS_FromPath` is not available.** It opens files and URLs through GDAL, and
  the browser build has neither a local filesystem nor GDAL's `/vsicurl`
  network access. Fetch the bytes in JavaScript and use `registerGeoTIFF()`
  instead.
- **`RS_AsRaster`** requires a reference raster without skew, and the geometry
  must carry a CRS when the reference raster has one.
- All raster processing runs on the thread that created the database. Create
  the database in a Web Worker to keep large rasters off the main thread.
