# Getting Started

## Install a package

Choose the package that matches the SQL surface you need:

- `@cereusdb/minimal`
- `@cereusdb/standard`
- `@cereusdb/global`
- `@cereusdb/full`

```bash
npm install @cereusdb/standard
```

## Create a database

```ts
import { CereusDB } from '@cereusdb/standard';

const db = await CereusDB.create();
```

## Run SQL

```ts
const rows = await db.sqlJSON(`
  SELECT ST_AsText(
    ST_Transform(
      ST_GeomFromWKT('POINT(13.4 52.5)'),
      'EPSG:4326',
      'EPSG:3857'
    )
  ) AS geom
`);
```

## Register data

```ts
await db.registerRemoteParquet('cities', 'https://example.com/cities.parquet');
db.registerGeoJSON('regions', geojsonObject);
```

All packages read Parquet files compressed with Snappy, Gzip, Brotli, LZ4, or ZSTD.

`registerRemoteParquet()` downloads a whole remote Parquet file into the browser runtime. For ranged reads, exact object URLs, and object-store listing, use the browser object-store API in `@cereusdb/standard`, `@cereusdb/global`, or `@cereusdb/full`:

```ts
db.registerObjectStores({
  stores: [
    {
      provider: 'http',
      url: 'https://example.com',
    },
  ],
});

await db.registerParquetTable('cities', 'https://example.com/cities.parquet');
```

`@cereusdb/full` additionally supports:

```ts
db.registerGeoTIFF('raster', bytes);
db.registerRaster('raster', bytes, 'geotiff');
```

## Keep data across page reloads

Tables live in memory by default. To keep them, create a persistent database in
the browser's Origin Private File System and create tables in it:

```ts
const db = await CereusDB.create({ attach: ['opfs://mydb'] }); // opens or creates mydb

await db.sqlJSON(`CREATE TABLE mydb.public.regions AS SELECT * FROM regions`);
await db.sqlJSON(`USE mydb`);
```

See [Persistent Databases](./persistent-databases.md).

## Export data

```ts
await db.downloadGeoParquet('mydb.public.regions'); // downloads regions.parquet
await db.sqlJSON(`COPY regions TO 'regions.parquet'`); // the same in SQL
```

See [GeoParquet Export](./geoparquet-export.md).
