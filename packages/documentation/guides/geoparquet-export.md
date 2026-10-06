# GeoParquet Export

CereusDB can export any table or query result as a
[GeoParquet](https://geoparquet.org/) 1.1 file, available in all four
packages. There are three ways to do it:

| | Returns | Use it to |
|---|---|---|
| `db.exportGeoParquet(queryOrTable, options)` | the file as a `Uint8Array` | upload, store or process the file yourself |
| `db.downloadGeoParquet(queryOrTable, options)` | the file name | save the file in the browser |
| `COPY ... TO '<file>'` in SQL | a `count` row | export from SQL, for example in a SQL console |

`queryOrTable` is either a query (starting with `SELECT`, `WITH`, `VALUES` or
`(`) or a table name such as `mydb.public.cities`.

## Getting the bytes

```ts
const bytes = await db.exportGeoParquet('SELECT * FROM mydb.public.cities', {
  compression: 'zstd', // default; also 'snappy', 'lz4', 'gzip', 'brotli', 'uncompressed'
  rowGroupSize: 100_000,
});
```

## Downloading in the browser

```ts
await db.downloadGeoParquet('mydb.public.cities'); // saves cities.parquet
await db.downloadGeoParquet('SELECT * FROM cities WHERE pop > 1000000', {
  filename: 'big_cities.parquet', // default for queries: export.parquet
  compression: 'snappy',
});
```

The download is started from code with a temporary `<a download>` link, so it
needs no click by the user. Browsers may ask for permission when a page starts
several downloads in a row.

## Exporting with SQL

`COPY` exports a table or a query result and returns the number of rows:

```sql
COPY mydb.public.cities TO 'cities.parquet';

COPY (SELECT name, geom FROM cities WHERE pop > 1000000) TO 'big_cities.parquet'
  STORED AS GEOPARQUET
  OPTIONS (compression 'snappy', row_group_size 100000);
```

- The target is a file name. The format is GeoParquet, either from a `.parquet`
  (or `.geoparquet`) extension or from `STORED AS GEOPARQUET` (`PARQUET` is
  accepted too).
- Supported options: `compression` and `row_group_size` (also with the
  `format.` prefix used by DataFusion, for example `'format.compression'`).
- `PARTITIONED BY` and URL targets (such as `opfs://...`) are not supported.

## Export handlers

`downloadGeoParquet()` and `COPY` don't save files themselves; they pass each
file to an export handler, `(filename, data, mimeType) => void | Promise<void>`.

- In the browser's main thread, the default handler is `downloadFile()`, which
  starts a download.
- In a Web Worker or in Node.js there is nothing to download into, so pass your
  own handler. Without one, exports fail with an error.

```ts
// In a Web Worker: send the file to the page, which can download it.
const db = await CereusDB.create({
  onExport: (filename, data, mimeType) => {
    self.postMessage({ type: 'export', filename, data, mimeType }, [data.buffer]);
  },
});

// In Node.js: write the file to disk.
import { writeFile } from 'node:fs/promises';
const nodeDb = await CereusDB.create({
  wasmSource,
  onExport: (filename, data) => writeFile(filename, data),
});
```

Pass `onExport: false` to turn exports off. `downloadFile(filename, data,
mimeType)` is exported as well, for example to download a file from the main
thread after receiving it from a worker.

## What the file contains

- Geometry and geography columns are described in the file's `geo` metadata:
  WKB encoding, the bounding box of each geometry column, and its CRS.
- A CRS of OGC:CRS84 (or EPSG:4326) is the GeoParquet default and is omitted.
  Other CRSs are written as PROJJSON, which needs PROJ (`standard`, `global`
  and `full` packages); in `minimal`, exporting such a column fails. Columns
  without a CRS are written with `"crs": null`.
- Geography columns are marked with `"edges": "spherical"`.
- The Arrow schema is stored as well, so CereusDB (`registerFile()`) and other
  Arrow-based readers restore the geometry types exactly.
- A result without geometry columns is written as plain Parquet.

The export runs the query and holds the result and the file in memory, so very
large exports are limited by the browser's WebAssembly memory.
