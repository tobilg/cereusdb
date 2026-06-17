import { describe, expect, it } from 'vitest';

import type { ObjectStoreRegistryConfig, RegisterParquetTableOptions } from '../src/index';
import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

const configJson = process.env.CEREUSDB_OBJECT_STORE_CONFIG_JSON;
const tableUrl = process.env.CEREUSDB_OBJECT_STORE_TABLE_URL;
const tableOptionsJson = process.env.CEREUSDB_OBJECT_STORE_TABLE_OPTIONS_JSON;
const tableName = process.env.CEREUSDB_OBJECT_STORE_TABLE_NAME ?? 'cloud_parquet_smoke';

const describeIfConfigured =
  configJson !== undefined && tableUrl !== undefined ? describe : describe.skip;

describeIfConfigured('browser object store cloud smoke', () => {
  let ctx: TestContext;

  it('registers and scans a cloud Parquet object or prefix', async () => {
    ctx = await createTestContext();
    const config = JSON.parse(configJson ?? '{}') as ObjectStoreRegistryConfig;
    const tableOptions =
      tableOptionsJson === undefined
        ? undefined
        : (JSON.parse(tableOptionsJson) as RegisterParquetTableOptions);

    ctx.db.registerObjectStores(config);
    await ctx.db.registerParquetTable(tableName, tableUrl as string, tableOptions);

    const rows = await ctx.db.sqlJSON(`SELECT COUNT(*) AS row_count FROM ${tableName}`);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.row_count)).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
