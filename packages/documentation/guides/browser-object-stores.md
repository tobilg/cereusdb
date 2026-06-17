# Browser Object Stores

`@cereusdb/standard`, `@cereusdb/global`, and `@cereusdb/full` can register browser-backed object stores for remote Parquet tables. `@cereusdb/minimal` does not include this feature.

This path uses the browser `fetch` API as the transport for upstream `object_store` providers, so S3, Google Cloud Storage, and Azure Blob Storage keep their provider-specific signing, listing, pagination, and response parsing.

## Package Support

| Package | Browser object stores |
| --- | --- |
| `@cereusdb/minimal` | No |
| `@cereusdb/standard` | Yes |
| `@cereusdb/global` | Yes |
| `@cereusdb/full` | Yes |

## Exact HTTP objects

Use the generic HTTP provider for servers that expose exact Parquet files and support `HEAD` plus ranged `GET` requests:

```ts
const db = await CereusDB.create({
  objectStores: {
    maxConcurrency: 8,
    stores: [
      {
        provider: 'http',
        url: 'https://data.example.com',
      },
    ],
  },
});

await db.registerParquetTable(
  'cities',
  'https://data.example.com/parquet/cities.parquet',
);
```

Generic HTTP has no standard directory listing API. Exact-file reads need only `HEAD` and ranged `GET`, but prefix registration, partition discovery, and globs require the server to support the listing protocol expected by upstream `object_store`.

## Cloud providers

Use the cloud providers when you need object-store semantics such as S3, GCS, or Azure listing:

```ts
db.registerObjectStores({
  maxConcurrency: 16,
  stores: [
    {
      provider: 's3',
      url: 's3://example-bucket',
      options: {
        region: 'us-east-1',
        skip_signature: true,
      },
    },
  ],
});

await db.registerParquetTable('events', 's3://example-bucket/events/');
```

For private data, prefer presigned URLs, SAS tokens, OAuth access tokens, or short-lived temporary credentials from your application backend. Long-lived AWS, GCP, or Azure secrets should not be shipped to browser clients.

For a private S3 bucket with temporary STS credentials, pass the STS `SessionToken` as `token`:

```ts
db.registerObjectStores({
  stores: [
    {
      provider: 's3',
      url: 's3://private-bucket',
      options: {
        region: 'us-east-1',
        access_key_id: '<STS AccessKeyId>',
        secret_access_key: '<STS SecretAccessKey>',
        token: '<STS SessionToken>',
      },
    },
  ],
});

await db.registerParquetTable(
  'private_events',
  's3://private-bucket/events/part-0000.parquet',
);
```

The accepted S3 session-token option aliases are `token`, `session_token`, `aws_token`, and `aws_session_token`. For long-lived IAM user keys there is no session token, so omit `token`.

S3-compatible services can be reached with the `endpoint` option:

```ts
db.registerObjectStores({
  stores: [
    {
      provider: 's3',
      url: 's3://my-bucket',
      options: {
        region: 'us-east-1',
        endpoint: 'https://s3.example.com',
        access_key_id: '<access key>',
        secret_access_key: '<secret key>',
      },
    },
  ],
});
```

For local MinIO or LocalStack over plain HTTP, also set `allow_http: true`:

```ts
db.registerObjectStores({
  stores: [
    {
      provider: 's3',
      url: 's3://my-bucket',
      options: {
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:9000',
        allow_http: true,
        access_key_id: 'minioadmin',
        secret_access_key: 'minioadmin',
      },
    },
  ],
});
```

Custom S3 endpoints use path-style requests by default, for example `http://127.0.0.1:9000/my-bucket/path/to/file.parquet`. If your provider requires virtual-hosted-style requests, set `virtual_hosted_style_request: true` and include the bucket in the endpoint host, for example `https://my-bucket.s3.example.com`.

## CORS

Browser requests are subject to CORS. Buckets or proxy endpoints must allow the methods and headers used by the provider:

- methods: `GET`, `HEAD`, and provider listing requests
- request headers: `Range`, `Authorization`, and provider headers such as `x-amz-*`, `x-goog-*`, or `x-ms-*`
- exposed response headers: `Accept-Ranges`, `Content-Length`, `Content-Range`, `ETag`, `Last-Modified`, and provider request/version headers as needed

The browser also forbids application code from setting some headers, including `Host`, `User-Agent`, and `Content-Length`. Provider signing must use headers that can actually be sent by `fetch`.

## Startup registration

Object stores can be registered at startup:

```ts
const db = await CereusDB.create({
  objectStores: {
    stores: [
      {
        provider: 'azure',
        url: 'az://container',
        options: {
          account: 'storageaccount',
          sas_token: '<short-lived SAS token>',
        },
      },
    ],
  },
});
```

Or after initialization:

```ts
db.registerObjectStores({
  stores: [
    {
      provider: 'gcs',
      url: 'gs://example-bucket',
      options: {
        skip_signature: true,
      },
    },
  ],
});
```

Exact object URLs avoid listing. Prefix URLs ending in `/` use provider listing and are needed for partition discovery and globs.

## Cloud smoke test

The repository includes an opt-in smoke test for real cloud endpoints:

```bash
cd js
CEREUSDB_OBJECT_STORE_CONFIG_JSON='{"stores":[{"provider":"s3","url":"s3://example-bucket","options":{"region":"us-east-1","skip_signature":true}}]}' \
CEREUSDB_OBJECT_STORE_TABLE_URL='s3://example-bucket/events/part-0000.parquet' \
npm run smoke:object-store-cloud
```

Use a trailing `/` to test a partitioned prefix and provider listing:

```bash
cd js
CEREUSDB_OBJECT_STORE_CONFIG_JSON='{"stores":[{"provider":"s3","url":"s3://example-bucket","options":{"region":"us-east-1","skip_signature":true}}]}' \
CEREUSDB_OBJECT_STORE_TABLE_URL='s3://example-bucket/events/' \
CEREUSDB_OBJECT_STORE_TABLE_OPTIONS_JSON='{"fileExtension":".parquet","targetPartitions":8}' \
npm run smoke:object-store-cloud
```

Use short-lived STS credentials for private S3 smoke tests:

```bash
cd js
CEREUSDB_OBJECT_STORE_CONFIG_JSON='{"stores":[{"provider":"s3","url":"s3://private-bucket","options":{"region":"us-east-1","access_key_id":"<STS AccessKeyId>","secret_access_key":"<STS SecretAccessKey>","token":"<STS SessionToken>"}}]}' \
CEREUSDB_OBJECT_STORE_TABLE_URL='s3://private-bucket/events/part-0000.parquet' \
npm run smoke:object-store-cloud
```

Use a custom S3-compatible endpoint by setting `endpoint`:

```bash
cd js
CEREUSDB_OBJECT_STORE_CONFIG_JSON='{"stores":[{"provider":"s3","url":"s3://my-bucket","options":{"region":"us-east-1","endpoint":"https://s3.example.com","access_key_id":"<access key>","secret_access_key":"<secret key>"}}]}' \
CEREUSDB_OBJECT_STORE_TABLE_URL='s3://my-bucket/path/to/file.parquet' \
npm run smoke:object-store-cloud
```

Use `allow_http: true` for local HTTP endpoints:

```bash
cd js
CEREUSDB_OBJECT_STORE_CONFIG_JSON='{"stores":[{"provider":"s3","url":"s3://my-bucket","options":{"region":"us-east-1","endpoint":"http://127.0.0.1:9000","allow_http":true,"access_key_id":"minioadmin","secret_access_key":"minioadmin"}}]}' \
CEREUSDB_OBJECT_STORE_TABLE_URL='s3://my-bucket/path/to/file.parquet' \
npm run smoke:object-store-cloud
```

Set `CEREUSDB_OBJECT_STORE_TABLE_OPTIONS_JSON` when you need non-default Parquet registration options, for example `{"fileExtension":".parquet","targetPartitions":8}`.
