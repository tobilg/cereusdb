import { beforeAll, describe, expect, it } from 'vitest';

import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

const DISTANCE_JOIN_FIXTURE_CTE = `
  WITH left_points AS (
    SELECT * FROM (VALUES
      (1, ST_Point(0, 0)),
      (2, ST_Point(10, 0))
    ) AS t(id, geom)
  ),
  right_points AS (
    SELECT * FROM (VALUES
      (101, ST_Point(0.75, 0)),
      (102, ST_Point(2, 0)),
      (103, ST_Point(9.4, 0)),
      (104, ST_Point(20, 0))
    ) AS t(id, geom)
  )
`;

describe('TypeScript WASM distance join support', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  it('plans ST_DWithin joins through SpatialJoinExec', async () => {
    const rows = await ctx.db.sqlJSON(`
      EXPLAIN
      ${DISTANCE_JOIN_FIXTURE_CTE}
      SELECT l.id AS left_id, r.id AS right_id
      FROM left_points AS l
      JOIN right_points AS r
        ON ST_DWithin(l.geom, r.geom, 1.0)
    `);

    const plan = rows.map((row) => String(row.plan)).join('\n');
    expect(plan).toContain('SpatialJoinExec');
    expect(plan.toLowerCase()).toContain('st_dwithin');
  });

  it('returns the expected matches for ST_DWithin joins', async () => {
    const rows = await ctx.db.sqlJSON(`
      ${DISTANCE_JOIN_FIXTURE_CTE}
      SELECT l.id AS left_id, r.id AS right_id
      FROM left_points AS l
      JOIN right_points AS r
        ON ST_DWithin(l.geom, r.geom, 1.0)
      ORDER BY left_id, right_id
    `);

    expect(rows).toEqual([
      { left_id: 1, right_id: 101 },
      { left_id: 2, right_id: 103 },
    ]);
  });

  it('plans ST_Distance comparison joins through SpatialJoinExec', async () => {
    const rows = await ctx.db.sqlJSON(`
      EXPLAIN
      ${DISTANCE_JOIN_FIXTURE_CTE}
      SELECT l.id AS left_id, r.id AS right_id
      FROM left_points AS l
      JOIN right_points AS r
        ON ST_Distance(l.geom, r.geom) < 1.0
    `);

    const plan = rows.map((row) => String(row.plan)).join('\n');
    expect(plan).toContain('SpatialJoinExec');
    expect(plan.toLowerCase()).toContain('st_distance');
  });

  it('returns the expected matches for ST_Distance comparison joins', async () => {
    const rows = await ctx.db.sqlJSON(`
      ${DISTANCE_JOIN_FIXTURE_CTE}
      SELECT l.id AS left_id, r.id AS right_id
      FROM left_points AS l
      JOIN right_points AS r
        ON ST_Distance(l.geom, r.geom) < 1.0
      ORDER BY left_id, right_id
    `);

    expect(rows).toEqual([
      { left_id: 1, right_id: 101 },
      { left_id: 2, right_id: 103 },
    ]);
  });
});
