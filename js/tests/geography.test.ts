import { beforeAll, describe, expect, it } from 'vitest';

import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

describe('TypeScript WASM geography support', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  it('registers geography constructors and conversion helpers in the runtime catalog', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT routine_name
      FROM information_schema.routines
      WHERE routine_name IN (
        'st_asewkt',
        'st_geogfromewkb',
        'st_geogfromewkt',
        'st_geogtogeometry',
        'st_geomtogeography'
      )
      ORDER BY routine_name
    `);

    expect(rows).toEqual([
      { routine_name: 'st_asewkt' },
      { routine_name: 'st_geogfromewkb' },
      { routine_name: 'st_geogfromewkt' },
      { routine_name: 'st_geogtogeometry' },
      { routine_name: 'st_geomtogeography' },
    ]);
  });

  it('serializes geography values to EWKT when the CRS is representable as an SRID', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT ST_AsEWKT(ST_GeogFromEWKT('SRID=3857;POINT(1 2)')) AS value
    `);

    expect(rows).toEqual([{ value: 'SRID=3857;POINT(1 2)' }]);
  });

  it('reads geography EWKT with embedded CRS metadata', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT
        ST_AsText(ST_GeogFromEWKT('SRID=3857;POINT(1 2)')) AS geom,
        ST_CRS(ST_GeogFromEWKT('SRID=3857;POINT(1 2)')) AS crs
    `);

    expect(rows).toEqual([{ geom: 'POINT(1 2)', crs: 'EPSG:3857' }]);
  });

  it('reads geography EWKB with embedded CRS metadata', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT
        ST_AsText(
          ST_GeogFromEWKB(ST_AsEWKB(ST_SetSRID(ST_Point(1, 2), 3857)))
        ) AS geom,
        ST_CRS(
          ST_GeogFromEWKB(ST_AsEWKB(ST_SetSRID(ST_Point(1, 2), 3857)))
        ) AS crs
    `);

    expect(rows).toEqual([{ geom: 'POINT(1 2)', crs: 'EPSG:3857' }]);
  });

  it('converts between geometry and geography without losing CRS', async () => {
    const rows = await ctx.db.sqlJSON(`
      SELECT
        ST_CRS(ST_GeomToGeography(ST_GeomFromEWKT('SRID=3857;POINT(1 2)'))) AS geog_crs,
        ST_CRS(ST_GeogToGeometry(ST_GeogFromEWKT('SRID=3857;POINT(1 2)'))) AS geom_crs
    `);

    expect(rows).toEqual([{ geog_crs: 'EPSG:3857', geom_crs: 'EPSG:3857' }]);
  });
});
