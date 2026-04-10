import { beforeAll, describe, expect, it } from 'vitest';

import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

describe('TypeScript WASM random geometry table function', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  it('generates the requested row count across partitions', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT COUNT(*) AS row_count
      FROM sd_random_geometry('{"num_rows": 9, "num_partitions": 2, "rows_per_batch": 2, "seed": 7}')
    `);

    expect(rows).toEqual([{ row_count: 9 }]);
  });

  it('is deterministic with a fixed seed', async () => {
    const query = `
      SELECT id, ROUND(dist, 6) AS dist, ST_AsText(geometry) AS geometry
      FROM sd_random_geometry('{"num_rows": 4, "rows_per_batch": 2, "seed": 3840, "geom_type": "Point"}')
      ORDER BY id
    `;

    const first = await ctx.db.sqlJSON(query);
    const second = await ctx.db.sqlJSON(query);

    expect(second).toEqual(first);
  });

  it('rejects invalid JSON options', async () => {
    await expect(
      ctx.db.sqlJSON("SELECT * FROM sd_random_geometry('not json')"),
    ).rejects.toThrow('Failed to parse options');
  });
});
