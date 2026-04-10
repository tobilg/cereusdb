import { beforeAll, describe, expect, it } from 'vitest';

import { targetPackage } from './support/package';
import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

describe('TypeScript WASM PROJ support', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  it('runs the PROJ-enabled package tier', () => {
    expect(targetPackage).not.toBe('geos');
  });

  it('registers ST_Transform in the runtime catalog', async () => {
    const rows = await ctx.db.sqlJSON(
      "SELECT routine_name FROM information_schema.routines WHERE routine_name = 'st_transform'",
    );

    expect(rows).toEqual([{ routine_name: 'st_transform' }]);
  });

  it('reprojects coordinates through ST_Transform', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT ST_AsText(
        ST_Transform(
          ST_GeomFromWKT('POINT(1 1)'),
          'EPSG:4326',
          'EPSG:3857'
        )
      ) AS projected
    `);

    expect(rows).toEqual([
      {
        projected: 'POINT(111319.49079327357 111325.1428663851)',
      },
    ]);
  });
});
