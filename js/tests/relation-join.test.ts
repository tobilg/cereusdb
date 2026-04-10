import { beforeAll, describe, expect, it } from 'vitest';

import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

interface RelationJoinCase {
  name: string;
  predicate: string;
  leftRows: string;
  rightRows: string;
  expected: Array<{ left_id: number; right_id: number }>;
}

const relationCases: RelationJoinCase[] = [
  {
    name: 'st_intersects',
    predicate: 'ST_Intersects(l.geom, r.geom)',
    leftRows: "(1, ST_GeomFromText('LINESTRING(0 0,2 2)'))",
    rightRows: "(10, ST_GeomFromText('LINESTRING(0 2,2 0)'))",
    expected: [{ left_id: 1, right_id: 10 }],
  },
  {
    name: 'st_contains',
    predicate: 'ST_Contains(l.geom, r.geom)',
    leftRows: "(1, ST_GeomFromText('POLYGON((0 0,5 0,5 5,0 5,0 0))'))",
    rightRows: "(10, ST_Point(1, 1))",
    expected: [{ left_id: 1, right_id: 10 }],
  },
  {
    name: 'st_within',
    predicate: 'ST_Within(l.geom, r.geom)',
    leftRows: '(1, ST_Point(1, 1))',
    rightRows: "(10, ST_GeomFromText('POLYGON((0 0,5 0,5 5,0 5,0 0))'))",
    expected: [{ left_id: 1, right_id: 10 }],
  },
  {
    name: 'st_covers',
    predicate: 'ST_Covers(l.geom, r.geom)',
    leftRows: "(1, ST_GeomFromText('POLYGON((0 0,5 0,5 5,0 5,0 0))'))",
    rightRows: '(10, ST_Point(0, 0))',
    expected: [{ left_id: 1, right_id: 10 }],
  },
  {
    name: 'st_coveredby',
    predicate: 'ST_CoveredBy(l.geom, r.geom)',
    leftRows: '(1, ST_Point(0, 0))',
    rightRows: "(10, ST_GeomFromText('POLYGON((0 0,5 0,5 5,0 5,0 0))'))",
    expected: [{ left_id: 1, right_id: 10 }],
  },
  {
    name: 'st_touches',
    predicate: 'ST_Touches(l.geom, r.geom)',
    leftRows: "(1, ST_GeomFromText('POLYGON((0 0,2 0,2 2,0 2,0 0))'))",
    rightRows: "(10, ST_GeomFromText('POLYGON((2 0,4 0,4 2,2 2,2 0))'))",
    expected: [{ left_id: 1, right_id: 10 }],
  },
  {
    name: 'st_crosses',
    predicate: 'ST_Crosses(l.geom, r.geom)',
    leftRows: "(1, ST_GeomFromText('LINESTRING(0 0,2 2)'))",
    rightRows: "(10, ST_GeomFromText('LINESTRING(0 2,2 0)'))",
    expected: [{ left_id: 1, right_id: 10 }],
  },
  {
    name: 'st_overlaps',
    predicate: 'ST_Overlaps(l.geom, r.geom)',
    leftRows: "(1, ST_GeomFromText('POLYGON((0 0,3 0,3 3,0 3,0 0))'))",
    rightRows: "(10, ST_GeomFromText('POLYGON((2 2,5 2,5 5,2 5,2 2))'))",
    expected: [{ left_id: 1, right_id: 10 }],
  },
  {
    name: 'st_equals',
    predicate: 'ST_Equals(l.geom, r.geom)',
    leftRows: "(1, ST_GeomFromText('POLYGON((0 0,2 0,2 2,0 2,0 0))'))",
    rightRows: "(10, ST_GeomFromText('POLYGON((0 0,2 0,2 2,0 2,0 0))'))",
    expected: [{ left_id: 1, right_id: 10 }],
  },
];

describe('TypeScript WASM relation join coverage', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  for (const relationCase of relationCases) {
    it(`plans ${relationCase.name} joins through SpatialJoinExec`, async () => {
      const rows = await ctx.db.sqlJSON(`
        EXPLAIN
        WITH left_side AS (
          SELECT * FROM (VALUES ${relationCase.leftRows}) AS t(id, geom)
        ),
        right_side AS (
          SELECT * FROM (VALUES ${relationCase.rightRows}) AS t(id, geom)
        )
        SELECT l.id AS left_id, r.id AS right_id
        FROM left_side AS l
        JOIN right_side AS r
          ON ${relationCase.predicate}
      `);

      const plan = rows.map((row) => String(row.plan)).join('\n');
      expect(plan).toContain('SpatialJoinExec');
      expect(plan.toLowerCase()).toContain(relationCase.name);
    });

    it(`returns the expected matches for ${relationCase.name}`, async () => {
      const rows = await ctx.db.sqlJSON(`
        WITH left_side AS (
          SELECT * FROM (VALUES ${relationCase.leftRows}) AS t(id, geom)
        ),
        right_side AS (
          SELECT * FROM (VALUES ${relationCase.rightRows}) AS t(id, geom)
        )
        SELECT l.id AS left_id, r.id AS right_id
        FROM left_side AS l
        JOIN right_side AS r
          ON ${relationCase.predicate}
        ORDER BY left_id, right_id
      `);

      expect(rows).toEqual(relationCase.expected);
    });
  }

  it('handles contains/within inversion when the geometry arguments are reversed relative to join inputs', async () => {
    const containsRows = await ctx.db.sqlJSON(`
      WITH points AS (
        SELECT * FROM (VALUES (1, ST_Point(1, 1))) AS t(id, geom)
      ),
      polygons AS (
        SELECT * FROM (
          VALUES (10, ST_GeomFromText('POLYGON((0 0,5 0,5 5,0 5,0 0))'))
        ) AS t(id, geom)
      )
      SELECT p.id AS left_id, poly.id AS right_id
      FROM points AS p
      JOIN polygons AS poly
        ON ST_Contains(poly.geom, p.geom)
    `);

    const coversRows = await ctx.db.sqlJSON(`
      WITH points AS (
        SELECT * FROM (VALUES (1, ST_Point(0, 0))) AS t(id, geom)
      ),
      polygons AS (
        SELECT * FROM (
          VALUES (10, ST_GeomFromText('POLYGON((0 0,5 0,5 5,0 5,0 0))'))
        ) AS t(id, geom)
      )
      SELECT p.id AS left_id, poly.id AS right_id
      FROM points AS p
      JOIN polygons AS poly
        ON ST_Covers(poly.geom, p.geom)
    `);

    expect(containsRows).toEqual([{ left_id: 1, right_id: 10 }]);
    expect(coversRows).toEqual([{ left_id: 1, right_id: 10 }]);
  });
});
