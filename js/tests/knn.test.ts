import { beforeAll, describe, expect, it } from 'vitest';

import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

const KNN_FIXTURE_CTE = `
  WITH hotels AS (
    SELECT * FROM (VALUES
      (1, ST_Point(0, 0), 5),
      (2, ST_Point(10, 0), 4)
    ) AS t(id, geom, stars)
  ),
  restaurants AS (
    SELECT * FROM (VALUES
      (101, ST_Point(1, 0), 5),
      (102, ST_Point(3, 0), 4),
      (103, ST_Point(11, 0), 5),
      (104, ST_Point(20, 0), 3)
    ) AS t(id, geom, rating)
  )
`;

describe('TypeScript WASM ST_KNN support', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  it('registers ST_KNN in the runtime catalog', async () => {
    const rows = await ctx.db.sqlJSON(
      "SELECT routine_name FROM information_schema.routines WHERE routine_name = 'st_knn'",
    );

    expect(rows).toEqual([{ routine_name: 'st_knn' }]);
  });

  it('plans KNN joins through SpatialJoinExec', async () => {
    const rows = await ctx.db.sqlJSON(`
      EXPLAIN
      ${KNN_FIXTURE_CTE}
      SELECT h.id AS hotel_id, r.id AS restaurant_id
      FROM hotels AS h
      JOIN restaurants AS r
        ON ST_KNN(h.geom, r.geom, 2, false)
    `);

    const plan = rows.map((row) => String(row.plan)).join('\n');
    expect(plan).toContain('SpatialJoinExec');
    expect(plan).toContain('ST_KNN');
  });

  it('returns the expected nearest neighbours', async () => {
    const rows = await ctx.db.sqlJSON(`
      ${KNN_FIXTURE_CTE}
      SELECT h.id AS hotel_id, r.id AS restaurant_id
      FROM hotels AS h
      JOIN restaurants AS r
        ON ST_KNN(h.geom, r.geom, 2, false)
      ORDER BY hotel_id, restaurant_id
    `);

    expect(rows).toEqual([
      { hotel_id: 1, restaurant_id: 101 },
      { hotel_id: 1, restaurant_id: 102 },
      { hotel_id: 2, restaurant_id: 102 },
      { hotel_id: 2, restaurant_id: 103 },
    ]);
  });

  it('supports ST_KNN default arguments with implicit k=1 and use_spheroid=false', async () => {
    const rows = await ctx.db.sqlJSON(`
      ${KNN_FIXTURE_CTE}
      SELECT h.id AS hotel_id, r.id AS restaurant_id
      FROM hotels AS h
      JOIN restaurants AS r
        ON ST_KNN(h.geom, r.geom)
      ORDER BY hotel_id, restaurant_id
    `);

    expect(rows).toEqual([
      { hotel_id: 1, restaurant_id: 101 },
      { hotel_id: 2, restaurant_id: 103 },
    ]);
  });

  it('supports ST_KNN default use_spheroid with explicit k', async () => {
    const rows = await ctx.db.sqlJSON(`
      ${KNN_FIXTURE_CTE}
      SELECT h.id AS hotel_id, r.id AS restaurant_id
      FROM hotels AS h
      JOIN restaurants AS r
        ON ST_KNN(h.geom, r.geom, 2)
      ORDER BY hotel_id, restaurant_id
    `);

    expect(rows).toEqual([
      { hotel_id: 1, restaurant_id: 101 },
      { hotel_id: 1, restaurant_id: 102 },
      { hotel_id: 2, restaurant_id: 102 },
      { hotel_id: 2, restaurant_id: 103 },
    ]);
  });

  it('supports KNN when the query side is the right input', async () => {
    const rows = await ctx.db.sqlJSON(`
      ${KNN_FIXTURE_CTE}
      SELECT h.id AS hotel_id, r.id AS restaurant_id
      FROM restaurants AS r
      JOIN hotels AS h
        ON ST_KNN(h.geom, r.geom, 1, false)
      ORDER BY hotel_id, restaurant_id
    `);

    expect(rows).toEqual([
      { hotel_id: 1, restaurant_id: 101 },
      { hotel_id: 2, restaurant_id: 103 },
    ]);
  });

  it('supports literal use_spheroid=true in the current browser MVP', async () => {
    const rows = await ctx.db.sqlJSON(`
      ${KNN_FIXTURE_CTE}
      SELECT h.id AS hotel_id, r.id AS restaurant_id
      FROM hotels AS h
      JOIN restaurants AS r
        ON ST_KNN(h.geom, r.geom, 1, true)
      ORDER BY hotel_id, restaurant_id
    `);

    expect(rows).toEqual([
      { hotel_id: 1, restaurant_id: 101 },
      { hotel_id: 2, restaurant_id: 103 },
    ]);
  });

  it('applies non-KNN predicates after candidate selection', async () => {
    const onRows = await ctx.db.sqlJSON(`
      ${KNN_FIXTURE_CTE}
      SELECT h.id AS hotel_id, r.id AS restaurant_id
      FROM hotels AS h
      JOIN restaurants AS r
        ON ST_KNN(h.geom, r.geom, 2, false) AND r.rating > 4
      ORDER BY hotel_id, restaurant_id
    `);

    const whereRows = await ctx.db.sqlJSON(`
      ${KNN_FIXTURE_CTE}
      SELECT h.id AS hotel_id, r.id AS restaurant_id
      FROM hotels AS h
      JOIN restaurants AS r
        ON ST_KNN(h.geom, r.geom, 2, false)
      WHERE r.rating > 4
      ORDER BY hotel_id, restaurant_id
    `);

    expect(onRows).toEqual([
      { hotel_id: 1, restaurant_id: 101 },
      { hotel_id: 2, restaurant_id: 103 },
    ]);
    expect(whereRows).toEqual(onRows);
  });

  it('keeps query-side filters semantically equivalent whether written in ON or WHERE', async () => {
    const onRows = await ctx.db.sqlJSON(`
      ${KNN_FIXTURE_CTE}
      SELECT h.id AS hotel_id, r.id AS restaurant_id
      FROM hotels AS h
      JOIN restaurants AS r
        ON ST_KNN(h.geom, r.geom, 2, false) AND h.stars >= 5
      ORDER BY hotel_id, restaurant_id
    `);

    const whereRows = await ctx.db.sqlJSON(`
      ${KNN_FIXTURE_CTE}
      SELECT h.id AS hotel_id, r.id AS restaurant_id
      FROM hotels AS h
      JOIN restaurants AS r
        ON ST_KNN(h.geom, r.geom, 2, false)
      WHERE h.stars >= 5
      ORDER BY hotel_id, restaurant_id
    `);

    expect(onRows).toEqual([
      { hotel_id: 1, restaurant_id: 101 },
      { hotel_id: 1, restaurant_id: 102 },
    ]);
    expect(whereRows).toEqual(onRows);
  });

  it('fails clearly when k is not a literal', async () => {
    await expect(
      ctx.db.sqlJSON(`
        ${KNN_FIXTURE_CTE}
        SELECT h.id AS hotel_id, r.id AS restaurant_id
        FROM hotels AS h
        JOIN restaurants AS r
          ON ST_KNN(h.geom, r.geom, h.stars, false)
      `),
    ).rejects.toThrow('outside a spatial join');
  });

  it('fails clearly when use_spheroid is not a literal', async () => {
    await expect(
      ctx.db.sqlJSON(`
        ${KNN_FIXTURE_CTE}
        SELECT h.id AS hotel_id, r.id AS restaurant_id
        FROM hotels AS h
        JOIN restaurants AS r
          ON ST_KNN(h.geom, r.geom, 1, h.stars > 4)
      `),
    ).rejects.toThrow('outside a spatial join');
  });

  it('fails clearly when geography inputs are used in ST_KNN joins', async () => {
    await expect(
      ctx.db.sqlJSON(`
        WITH hotels AS (
          SELECT * FROM (VALUES
            (1, ST_GeogFromWKT('POINT(0 0)'))
          ) AS t(id, geom)
        ),
        restaurants AS (
          SELECT * FROM (VALUES
            (101, ST_GeogFromWKT('POINT(1 0)'))
          ) AS t(id, geom)
        )
        SELECT h.id AS hotel_id, r.id AS restaurant_id
        FROM hotels AS h
        JOIN restaurants AS r
          ON ST_KNN(h.geom, r.geom, 1, false)
      `),
    ).rejects.toThrow('outside a spatial join');
  });

  it('fails clearly when ST_KNN is composed under OR', async () => {
    await expect(
      ctx.db.sqlJSON(`
        ${KNN_FIXTURE_CTE}
        SELECT h.id AS hotel_id, r.id AS restaurant_id
        FROM hotels AS h
        JOIN restaurants AS r
          ON ST_KNN(h.geom, r.geom, 1, false) OR r.rating > 4
      `),
    ).rejects.toThrow('outside a spatial join');
  });
});
