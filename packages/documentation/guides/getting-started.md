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
