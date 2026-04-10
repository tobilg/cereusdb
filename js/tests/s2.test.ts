import { beforeAll, describe, expect, it } from 'vitest';

import { packageExpectations, targetPackage } from './support/package';
import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

describe('TypeScript WASM S2 package support', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  it('runs an S2-enabled package tier', () => {
    expect(packageExpectations[targetPackage].hasS2).toBe(true);
  });

  it('overrides sd_order for lng/lat geography values', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT CAST(sd_order(ST_GeogFromWKT('POINT(0 0)')) AS VARCHAR) AS cell_id
    `);

    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.cell_id)).toBe('1152921504606846977');
  });

  it('executes spherical geography distance through the S2 kernel family', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT ST_Distance(
        ST_GeogFromWKT('POINT(0 0)'),
        ST_GeogFromWKT('POINT(1 0)')
      ) AS distance_m
    `);

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.distance_m)).toBeCloseTo(111195.10117748393, 6);
  });

  it('executes spherical geography shortest-line through the S2 kernel family', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT ST_AsText(
        ST_ShortestLine(
          ST_GeogFromWKT('POINT(0 0)'),
          ST_GeogFromWKT('POINT(3 4)')
        )
      ) AS wkt
    `);

    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.wkt)).toContain('LINESTRING(0 0,3');
  });

  it('keeps non-S2 core geography constructors usable', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT ST_AsText(ST_GeogToGeometry(ST_GeogFromWKT('POINT(1 2)'))) AS wkt
    `);

    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.wkt)).toBe('POINT(1 2)');
  });
});
