import { beforeAll, describe, expect, it } from 'vitest';

import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

describe('TypeScript WASM package DDL', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  it('creates empty tables and honors IF NOT EXISTS', async () => {
    const tableName = 'ddl_empty_fixture';

    await expect(
      ctx.db.sqlJSON(`CREATE TABLE ${tableName} (id INT, name VARCHAR)`),
    ).resolves.toEqual([]);
    await expect(
      ctx.db.sqlJSON(`CREATE TABLE IF NOT EXISTS ${tableName} (ignored INT)`),
    ).resolves.toEqual([]);

    expect(ctx.db.tables()).toContain(tableName);

    const rows = await ctx.db.sqlJSON(`SELECT COUNT(*) AS row_count FROM ${tableName}`);
    expect(Number(rows[0]?.row_count)).toBe(0);
  });

  it('creates and replaces tables via CTAS', async () => {
    const tableName = 'ddl_ctas_fixture';

    await expect(
      ctx.db.sqlJSON(`
        CREATE TABLE ${tableName} AS
        SELECT * FROM (VALUES
          (1, 'Berlin'),
          (2, 'Paris')
        ) AS t(id, name)
      `),
    ).resolves.toEqual([]);

    let rows = await ctx.db.sqlJSON(`
      SELECT id, name
      FROM ${tableName}
      ORDER BY id
    `);

    expect(rows).toEqual([
      { id: 1, name: 'Berlin' },
      { id: 2, name: 'Paris' },
    ]);

    await expect(
      ctx.db.sqlJSON(`
        CREATE OR REPLACE TABLE ${tableName} AS
        SELECT * FROM (VALUES
          (7, 'Tokyo')
        ) AS t(id, name)
      `),
    ).resolves.toEqual([]);

    rows = await ctx.db.sqlJSON(`SELECT id, name FROM ${tableName}`);
    expect(rows).toEqual([{ id: 7, name: 'Tokyo' }]);
  });

  it('creates, replaces, and drops views', async () => {
    const tableName = 'ddl_view_source_fixture';
    const viewName = 'ddl_view_fixture';

    await expect(
      ctx.db.sqlJSON(`
        CREATE OR REPLACE TABLE ${tableName} AS
        SELECT * FROM (VALUES
          (1, 'alpha'),
          (2, 'beta')
        ) AS t(id, name)
      `),
    ).resolves.toEqual([]);

    await expect(
      ctx.db.sqlJSON(
        `CREATE VIEW ${viewName} AS SELECT COUNT(*) AS row_count FROM ${tableName}`,
      ),
    ).resolves.toEqual([]);

    let rows = await ctx.db.sqlJSON(`SELECT row_count FROM ${viewName}`);
    expect(Number(rows[0]?.row_count)).toBe(2);

    await expect(
      ctx.db.sqlJSON(
        `CREATE OR REPLACE VIEW ${viewName} AS SELECT MAX(id) AS max_id FROM ${tableName}`,
      ),
    ).resolves.toEqual([]);

    rows = await ctx.db.sqlJSON(`SELECT max_id FROM ${viewName}`);
    expect(Number(rows[0]?.max_id)).toBe(2);
    expect(ctx.db.tables()).toContain(viewName);

    await expect(ctx.db.sqlJSON(`DROP VIEW ${viewName}`)).resolves.toEqual([]);
    await expect(ctx.db.sqlJSON(`DROP VIEW IF EXISTS ${viewName}`)).resolves.toEqual([]);
    expect(ctx.db.tables()).not.toContain(viewName);
  });

  it('creates schema-qualified tables and drops schemas', async () => {
    const schemaName = 'ddl_schema_fixture';
    const tableName = 'cities';

    await expect(ctx.db.sqlJSON(`CREATE SCHEMA ${schemaName}`)).resolves.toEqual([]);
    await expect(
      ctx.db.sqlJSON(`
        CREATE TABLE ${schemaName}.${tableName} AS
        SELECT * FROM (VALUES
          (1, 'Rome')
        ) AS t(id, name)
      `),
    ).resolves.toEqual([]);

    const rows = await ctx.db.sqlJSON(`
      SELECT id, name
      FROM ${schemaName}.${tableName}
    `);
    expect(rows).toEqual([{ id: 1, name: 'Rome' }]);

    await expect(ctx.db.sqlJSON(`DROP TABLE ${schemaName}.${tableName}`)).resolves.toEqual([]);
    await expect(ctx.db.sqlJSON(`DROP SCHEMA ${schemaName}`)).resolves.toEqual([]);
    await expect(ctx.db.sqlJSON(`DROP SCHEMA IF EXISTS ${schemaName}`)).resolves.toEqual([]);
  });

  it('creates catalog-qualified schemas and tables', async () => {
    const catalogName = 'ddl_catalog_fixture';
    const schemaName = 'ddl_nested_schema_fixture';
    const tableName = 'cities';

    await expect(ctx.db.sqlJSON(`CREATE DATABASE ${catalogName}`)).resolves.toEqual([]);
    await expect(ctx.db.sqlJSON(`CREATE SCHEMA ${catalogName}.${schemaName}`)).resolves.toEqual([]);
    await expect(
      ctx.db.sqlJSON(`
        CREATE TABLE ${catalogName}.${schemaName}.${tableName} AS
        SELECT * FROM (VALUES
          (1, 'Madrid')
        ) AS t(id, name)
      `),
    ).resolves.toEqual([]);

    const rows = await ctx.db.sqlJSON(`
      SELECT id, name
      FROM ${catalogName}.${schemaName}.${tableName}
    `);
    expect(rows).toEqual([{ id: 1, name: 'Madrid' }]);

    await expect(
      ctx.db.sqlJSON(`DROP TABLE ${catalogName}.${schemaName}.${tableName}`),
    ).resolves.toEqual([]);
    await expect(ctx.db.sqlJSON(`DROP SCHEMA ${catalogName}.${schemaName}`)).resolves.toEqual([]);
  });

  it('drops tables through SQL', async () => {
    const tableName = 'ddl_drop_fixture';

    await expect(
      ctx.db.sqlJSON(`CREATE TABLE ${tableName} (id INT, name VARCHAR)`),
    ).resolves.toEqual([]);
    expect(ctx.db.tables()).toContain(tableName);

    await expect(ctx.db.sqlJSON(`DROP TABLE ${tableName}`)).resolves.toEqual([]);
    await expect(ctx.db.sqlJSON(`DROP TABLE IF EXISTS ${tableName}`)).resolves.toEqual([]);
    expect(ctx.db.tables()).not.toContain(tableName);
  });
});
