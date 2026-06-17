import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CereusDB } from '../src/index';
import {
  type HttpRangeFixtureServer,
  startHttpRangeFixtureServer,
} from './support/http-range-fixture-server';
import { targetPackage } from './support/package';
import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

const describeIfObjectStoreAvailable = targetPackage === 'minimal' ? describe.skip : describe;

describeIfObjectStoreAvailable('browser object stores', () => {
  let ctx: TestContext;
  let server: HttpRangeFixtureServer;

  beforeAll(async () => {
    ctx = await createTestContext();
    server = await startHttpRangeFixtureServer(ctx.parquetBytes);
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  it('registers an exact HTTP Parquet object through browser-backed ranged reads', async () => {
    ctx.db.registerObjectStores({
      maxConcurrency: 4,
      stores: [
        {
          provider: 'http',
          url: server.origin,
          options: { allow_http: true },
        },
      ],
    });

    await ctx.db.registerParquetTable('http_parquet_fixture', server.fileUrl, {
      targetPartitions: 4,
    });

    const rows = await ctx.db.sqlJSON('SELECT COUNT(*) AS row_count FROM http_parquet_fixture');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.row_count)).toBeGreaterThan(0);
    expect(server.requests.some((request) => request.method === 'HEAD')).toBe(true);
    expect(
      server.requests.some((request) => request.method === 'GET' && request.range !== undefined),
    ).toBe(true);
  }, 30_000);

  it('registers browser object stores during database creation', async () => {
    const db = await CereusDB.create({
      wasmSource: ctx.wasmBytes,
      objectStores: {
        maxConcurrency: 2,
        stores: [
          {
            provider: 'http',
            url: server.origin,
            options: { allow_http: true },
          },
        ],
      },
    });

    await db.registerParquetTable('startup_http_parquet_fixture', server.fileUrl);

    const rows = await db.sqlJSON(
      'SELECT COUNT(*) AS row_count FROM startup_http_parquet_fixture',
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.row_count)).toBeGreaterThan(0);
  }, 30_000);
});
