import { tableFromIPC } from 'apache-arrow';
import { beforeAll, describe, expect, it } from 'vitest';

import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

describe('TypeScript WASM package core', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  it('loads the WASM module from preloaded bytes', async () => {
    expect(await ctx.db.sqlJSON('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it('returns Arrow IPC data from sql()', async () => {
    const ipc = await ctx.db.sql('SELECT 1 AS one');
    const table = tableFromIPC(ipc);

    expect(table.numRows).toBe(1);
    expect(table.getChild('one')?.get(0)).toBe(1n);
  });

  it('plans regular spatial joins through SpatialJoinExec', async () => {
    const rows = await ctx.db.sqlJSON(`
      EXPLAIN
      WITH polygons AS (
        SELECT * FROM (VALUES
          (1, ST_GeomFromText('POLYGON((0 0,2 0,2 2,0 2,0 0))')),
          (2, ST_GeomFromText('POLYGON((3 3,5 3,5 5,3 5,3 3))'))
        ) AS t(id, geom)
      ),
      points AS (
        SELECT * FROM (VALUES
          (10, ST_Point(1, 1)),
          (20, ST_Point(4, 4)),
          (30, ST_Point(10, 10))
        ) AS t(id, geom)
      )
      SELECT polygons.id AS poly_id, points.id AS point_id
      FROM polygons
      JOIN points
        ON ST_Contains(polygons.geom, points.geom)
    `);

    const plan = rows.map((row) => String(row.plan)).join('\n');
    expect(plan).toContain('SpatialJoinExec');
    expect(plan.toLowerCase()).toContain('st_contains');
  });

  it('executes regular spatial joins with the optimized join path', async () => {
    const rows = await ctx.db.sqlJSON(`
      WITH polygons AS (
        SELECT * FROM (VALUES
          (1, ST_GeomFromText('POLYGON((0 0,2 0,2 2,0 2,0 0))')),
          (2, ST_GeomFromText('POLYGON((3 3,5 3,5 5,3 5,3 3))'))
        ) AS t(id, geom)
      ),
      points AS (
        SELECT * FROM (VALUES
          (10, ST_Point(1, 1)),
          (20, ST_Point(4, 4)),
          (30, ST_Point(10, 10))
        ) AS t(id, geom)
      )
      SELECT polygons.id AS poly_id, points.id AS point_id
      FROM polygons
      JOIN points
        ON ST_Contains(polygons.geom, points.geom)
      ORDER BY poly_id, point_id
    `);

    expect(rows).toEqual([
      { poly_id: 1, point_id: 10 },
      { poly_id: 2, point_id: 20 },
    ]);
  });

  it('registers GeoJSON objects with geometry and properties columns', async () => {
    const tableName = 'geojson_object_fixture';
    ctx.db.registerGeoJSON(tableName, {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'alpha', id: 1 },
          geometry: { type: 'Point', coordinates: [1, 2] },
        },
      ],
    });

    expect(ctx.db.tables()).toContain(tableName);

    const rows = await ctx.db.sqlJSON(`SELECT geometry, properties FROM ${tableName}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.geometry).toBe('POINT(1 2)');
    expect(String(rows[0]?.properties)).toContain('"name":"alpha"');
    expect(String(rows[0]?.properties)).toContain('"id":1');
  });

  it('registers GeoJSON files through registerFile()', async () => {
    const tableName = 'geojson_file_fixture';
    const file = new File(
      [
        JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { name: 'beta' },
              geometry: { type: 'Point', coordinates: [3, 4] },
            },
          ],
        }),
      ],
      'upload.geojson',
      { type: 'application/geo+json' },
    );

    await ctx.db.registerFile(tableName, file);

    const rows = await ctx.db.sqlJSON(`SELECT geometry, properties FROM ${tableName}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.geometry).toBe('POINT(3 4)');
    expect(String(rows[0]?.properties)).toContain('"name":"beta"');
  });

  it('registers Parquet files through registerFile()', async () => {
    const tableName = 'parquet_file_fixture';
    const file = new File([ctx.parquetBytes], 'cities.parquet', {
      type: 'application/octet-stream',
    });

    await ctx.db.registerFile(tableName, file);

    const rows = await ctx.db.sqlJSON(`SELECT COUNT(*) AS row_count FROM ${tableName}`);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.row_count)).toBeGreaterThan(0);
  });

  it('registers remote Parquet files through registerRemoteParquet()', async () => {
    const tableName = 'parquet_remote_fixture';
    await ctx.db.registerRemoteParquet(tableName, ctx.remoteParquetDataUrl);

    const rows = await ctx.db.sqlJSON(`SELECT COUNT(*) AS row_count FROM ${tableName}`);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.row_count)).toBeGreaterThan(0);
  });

  it('drops tables and rejects unsupported file extensions', async () => {
    const tableName = 'drop_fixture';
    ctx.db.registerGeoJSON(tableName, {
      type: 'FeatureCollection',
      features: [],
    });
    expect(ctx.db.tables()).toContain(tableName);

    ctx.db.dropTable(tableName);
    expect(ctx.db.tables()).not.toContain(tableName);

    await expect(
      ctx.db.registerFile('unsupported_fixture', new File(['hello'], 'notes.txt')),
    ).rejects.toThrow('Unsupported file format: .txt');
  });

  it('returns a non-empty version string', () => {
    expect(ctx.db.version()).toMatch(/\S/);
  });
});
