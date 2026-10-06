import { readFile } from 'node:fs/promises';

import { tableFromArrays, tableToIPC, Utf8, vectorFromArray } from 'apache-arrow';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CereusDB, MemoryStorageBackend, OPFSStorageBackend } from '../src/index';
import { createFakeOPFS } from './support/fake-opfs';
import { packageExpectations, targetPackage } from './support/package';
import { SAMPLE_GEOTIFF_PATH, WASM_PATH } from './support/paths';

let wasmBytes: Uint8Array;

beforeAll(async () => {
  wasmBytes = await readFile(WASM_PATH);
});

async function open(backend: MemoryStorageBackend, attach?: string[]): Promise<CereusDB> {
  return await CereusDB.create({ wasmSource: wasmBytes, storage: { opfs: backend }, attach });
}

function segmentFiles(backend: MemoryStorageBackend, root: string): string[] {
  return backend.paths().filter((path) => path.startsWith(`${root}/segments/`));
}

/** Whether `bytes` contains an LZ4 frame (magic number 0x184D2204). */
function hasLz4Frame(bytes: Uint8Array): boolean {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 0x04 && bytes[i + 1] === 0x22 && bytes[i + 2] === 0x4d && bytes[i + 3] === 0x18) {
      return true;
    }
  }
  return false;
}

/** Records every file read, to check what lazy loading reads. */
class CountingBackend extends MemoryStorageBackend {
  reads: string[] = [];

  override async readFile(path: string): Promise<Uint8Array | null> {
    this.reads.push(path);
    return await super.readFile(path);
  }
}

async function readManifest(backend: MemoryStorageBackend, root: string): Promise<any> {
  return JSON.parse(new TextDecoder().decode((await backend.readFile(`${root}/manifest.json`))!));
}

function segmentPaths(manifest: any, root: string, schema: string, table: string): string[] {
  return manifest.schemas[schema].tables[table].segments.map(
    (segment: { id: number }) => `${root}/segments/${segment.id}.arrow`,
  );
}

async function count(db: CereusDB, table: string): Promise<number> {
  const rows = await db.sqlJSON(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

describe('persistent databases', () => {
  it('persists tables, schemas, views, and DML across instances', async () => {
    const backend = new MemoryStorageBackend();
    const first = await open(backend);

    await first.sqlJSON(`CREATE DATABASE 'opfs://citydb'`);
    await first.sqlJSON(`
      CREATE TABLE citydb.public.cities AS
      SELECT * FROM (VALUES
        (1, 'Berlin', 13.40, 52.52),
        (2, 'Paris', 2.35, 48.86),
        (3, 'Madrid', -3.70, 40.42)
      ) AS t(id, name, lon, lat)
    `);
    await first.sqlJSON(`
      CREATE TABLE citydb.public.points AS
      SELECT id, ST_Point(lon, lat) AS geom FROM citydb.public.cities
    `);
    await expect(
      first.sqlJSON(`INSERT INTO citydb.public.cities VALUES (4, 'Rome', 12.50, 41.90)`),
    ).resolves.toEqual([{ count: 1 }]);
    await first.sqlJSON(`UPDATE citydb.public.cities SET name = 'Lisbon' WHERE id = 3`);
    await first.sqlJSON(`DELETE FROM citydb.public.cities WHERE id = 2`);
    await first.sqlJSON(`CREATE SCHEMA citydb.staging`);
    await first.sqlJSON(`CREATE TABLE citydb.staging.empty (id INT, label VARCHAR)`);
    await first.sqlJSON(
      `CREATE VIEW citydb.public.eastern AS SELECT name FROM citydb.public.cities WHERE lon > 10`,
    );
    await first.sqlJSON(`DETACH citydb`);
    expect(first.tables()).not.toContain('cities');

    const second = await open(backend);
    await second.sqlJSON(`ATTACH 'opfs://citydb'`);

    await expect(
      second.sqlJSON(`SELECT id, name FROM citydb.public.cities ORDER BY id`),
    ).resolves.toEqual([
      { id: 1, name: 'Berlin' },
      { id: 3, name: 'Lisbon' },
      { id: 4, name: 'Rome' },
    ]);
    await expect(
      second.sqlJSON(`SELECT id, ST_AsText(geom) AS wkt FROM citydb.public.points ORDER BY id`),
    ).resolves.toEqual([
      { id: 1, wkt: 'POINT(13.4 52.52)' },
      { id: 2, wkt: 'POINT(2.35 48.86)' },
      { id: 3, wkt: 'POINT(-3.7 40.42)' },
    ]);
    expect(await count(second, 'citydb.staging.empty')).toBe(0);
    await expect(
      second.sqlJSON(`SELECT name FROM citydb.public.eastern ORDER BY name`),
    ).resolves.toEqual([{ name: 'Berlin' }, { name: 'Rome' }]);
  });

  it('appends a segment per INSERT and rewrites on DELETE and compaction', async () => {
    const backend = new MemoryStorageBackend();
    const db = await open(backend);
    await db.sqlJSON(`CREATE DATABASE 'opfs://segdb'`);
    await db.sqlJSON(`CREATE TABLE segdb.public.t (id INT, label VARCHAR)`);
    expect(segmentFiles(backend, 'segdb')).toHaveLength(1);

    await db.sqlJSON(`INSERT INTO segdb.public.t VALUES (1, 'a')`);
    await db.sqlJSON(`INSERT INTO segdb.public.t VALUES (2, 'b'), (3, 'c')`);
    expect(segmentFiles(backend, 'segdb')).toHaveLength(3);

    await db.sqlJSON(`DELETE FROM segdb.public.t WHERE id = 1`);
    expect(segmentFiles(backend, 'segdb')).toHaveLength(1);

    await db.sqlJSON(`INSERT INTO segdb.public.t VALUES (4, 'd')`);
    await db.compactDatabase('segdb');
    expect(segmentFiles(backend, 'segdb')).toHaveLength(1);

    const manifest = JSON.parse(
      new TextDecoder().decode((await backend.readFile('segdb/manifest.json'))!),
    );
    expect(manifest.schemas.public.tables.t.segments).toEqual([
      { id: expect.any(Number), rows: 3 },
    ]);

    await db.sqlJSON(`INSERT OVERWRITE segdb.public.t VALUES (9, 'z')`);
    expect(segmentFiles(backend, 'segdb')).toHaveLength(1);
    await db.detachDatabase('segdb');
    await db.attachDatabase('opfs://segdb');
    await expect(db.sqlJSON(`SELECT * FROM segdb.public.t`)).resolves.toEqual([
      { id: 9, label: 'z' },
    ]);
  });

  it('compresses segments with LZ4 and reads them back', async () => {
    const backend = new MemoryStorageBackend();
    const first = await open(backend, ['opfs://lz4db']);
    await first.sqlJSON(`CREATE TABLE lz4db.public.t AS SELECT * FROM (VALUES (1), (2), (3)) AS v(id)`);
    // A Utf8View column with 3+ rows: its views buffer compresses, which produced
    // unreadable files before the arrow-ipc backport (patches/arrow-ipc).
    await first.sqlJSON(`ALTER TABLE lz4db.public.t ADD COLUMN s VARCHAR DEFAULT 'web'`);
    await first.sqlJSON(`
      INSERT INTO lz4db.public.t SELECT value, repeat('cereus', 20) FROM generate_series(4, 1000)
    `);

    const files = await Promise.all(
      segmentFiles(backend, 'lz4db').map(async (path) => (await backend.readFile(path))!),
    );
    expect(files).toHaveLength(2);
    expect(files.every(hasLz4Frame)).toBe(true);
    await first.detachDatabase('lz4db');

    const second = await open(backend, ['opfs://lz4db']);
    await expect(
      second.sqlJSON(`SELECT COUNT(*) AS n, COUNT(DISTINCT s) AS kinds FROM lz4db.public.t`),
    ).resolves.toEqual([{ n: 1000, kinds: 2 }]);
    await expect(second.sqlJSON(`SELECT s FROM lz4db.public.t WHERE id = 2`)).resolves.toEqual([
      { s: 'web' },
    ]);
  });

  it('reads uncompressed segments written by earlier versions', async () => {
    const backend = new MemoryStorageBackend();
    const legacy = tableFromArrays({
      id: Int32Array.from([1, 2, 3]),
      name: vectorFromArray(['a', 'b', 'c'], new Utf8()),
    });
    await backend.writeFile('legacydb/segments/1.arrow', tableToIPC(legacy, 'file'));
    await backend.writeFile(
      'legacydb/manifest.json',
      new TextEncoder().encode(
        JSON.stringify({
          format: 'cereusdb',
          version: 1,
          next_segment_id: 2,
          schemas: {
            public: {
              tables: { t: { segments: [{ id: 1, rows: 3 }] } },
              views: { broken: { sql: 'CREATE VIEW broken AS SELECT * FROM missing_table' } },
            },
          },
        }),
      ),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = await open(backend, ['opfs://legacydb']);
    warn.mockRestore();
    // A stored view without a column list is still listed (without columns).
    expect(
      (await db.catalog())
        .find((database) => database.name === 'legacydb')
        ?.schemas[0]?.tables.find((table) => table.name === 'broken'),
    ).toEqual({ name: 'broken', type: 'VIEW', columns: [] });
    await db.sqlJSON(`INSERT INTO legacydb.public.t VALUES (4, 'd')`);
    await db.detachDatabase('legacydb');

    // One uncompressed and one compressed segment in the same table.
    expect(segmentFiles(backend, 'legacydb')).toHaveLength(2);
    const reopened = await open(backend, ['opfs://legacydb']);
    await expect(
      reopened.sqlJSON(`SELECT id, name FROM legacydb.public.t ORDER BY id`),
    ).resolves.toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
      { id: 4, name: 'd' },
    ]);
  });

  it('persists column defaults and constraints', async () => {
    const backend = new MemoryStorageBackend();
    const first = await open(backend, ['opfs://defaultsdb']);
    await first.sqlJSON(`
      CREATE TABLE defaultsdb.public.items (
        id INT PRIMARY KEY,
        status VARCHAR DEFAULT 'new',
        qty INT DEFAULT 1 + 1
      )
    `);
    await first.sqlJSON(`INSERT INTO defaultsdb.public.items (id) VALUES (1)`);
    await first.sqlJSON(`ALTER TABLE defaultsdb.public.items ADD COLUMN source VARCHAR DEFAULT 'web'`);
    await first.sqlJSON(`ALTER TABLE defaultsdb.public.items RENAME COLUMN id TO item_id`);
    await first.detachDatabase('defaultsdb');

    expect((await readManifest(backend, 'defaultsdb')).schemas.public.tables.items).toMatchObject({
      schema: expect.any(String),
      column_defaults: { status: "'new'", qty: expect.any(String), source: "'web'" },
      constraints: [{ type: 'primary_key', columns: ['item_id'] }],
    });

    const second = await open(backend, ['opfs://defaultsdb']);
    await second.sqlJSON(`INSERT INTO defaultsdb.public.items (item_id) VALUES (2)`);
    await expect(
      second.sqlJSON(`SELECT * FROM defaultsdb.public.items ORDER BY item_id`),
    ).resolves.toEqual([
      { item_id: 1, status: 'new', qty: 2, source: 'web' },
      { item_id: 2, status: 'new', qty: 2, source: 'web' },
    ]);

    // Defaults and constraints survive a rewrite of a reloaded table.
    await second.sqlJSON(`DELETE FROM defaultsdb.public.items WHERE item_id = 1`);
    await second.detachDatabase('defaultsdb');
    expect((await readManifest(backend, 'defaultsdb')).schemas.public.tables.items).toMatchObject({
      column_defaults: { status: "'new'", source: "'web'" },
      constraints: [{ type: 'primary_key', columns: ['item_id'] }],
    });
  });

  it('loads table data only when a table is first used', async () => {
    const backend = new CountingBackend();
    const first = await open(backend, ['opfs://lazydb']);
    await first.sqlJSON(`CREATE TABLE lazydb.public.a AS SELECT * FROM (VALUES (1), (2), (3)) AS t(id)`);
    await first.sqlJSON(`INSERT INTO lazydb.public.a VALUES (4)`);
    await first.sqlJSON(`CREATE TABLE lazydb.public.b AS SELECT 'x' AS label, ST_Point(1, 2) AS geom`);
    await first.sqlJSON(`CREATE TABLE lazydb.public.c AS SELECT 1 AS id`);
    await first.sqlJSON(`CREATE VIEW lazydb.public.a_view AS SELECT id FROM lazydb.public.a WHERE id > 2`);
    await first.detachDatabase('lazydb');
    const manifest = await readManifest(backend, 'lazydb');

    // Attaching reads only the manifest; describing tables reads nothing more.
    backend.reads = [];
    const second = await open(backend, ['opfs://lazydb']);
    await second.catalog();
    await second.sqlJSON(`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_catalog = 'lazydb'
    `);
    expect(backend.reads).toEqual(['lazydb/manifest.json']);

    // A query loads only the tables it uses (both segments of a), once.
    backend.reads = [];
    await expect(second.sqlJSON(`SELECT * FROM lazydb.public.a_view ORDER BY id`)).resolves.toEqual([
      { id: 3 },
      { id: 4 },
    ]);
    await Promise.all([count(second, 'lazydb.public.a'), count(second, 'lazydb.public.a')]);
    expect(backend.reads).toEqual(segmentPaths(manifest, 'lazydb', 'public', 'a'));

    // Concurrent first uses load a table once.
    backend.reads = [];
    const [first_b, second_b] = await Promise.all([
      second.sqlJSON(`SELECT label, ST_AsText(geom) AS wkt FROM lazydb.public.b`),
      second.sqlJSON(`SELECT label, ST_AsText(geom) AS wkt FROM lazydb.public.b`),
    ]);
    expect(first_b).toEqual([{ label: 'x', wkt: 'POINT(1 2)' }]);
    expect(second_b).toEqual(first_b);
    expect(backend.reads).toEqual(segmentPaths(manifest, 'lazydb', 'public', 'b'));

    // Renaming within the database and dropping do not need the data.
    backend.reads = [];
    await second.sqlJSON(`ALTER TABLE lazydb.public.c RENAME TO c_renamed`);
    await second.sqlJSON(`DROP TABLE lazydb.public.c_renamed`);
    expect(backend.reads).toEqual([]);

    // Moving a table out of the database loads it first.
    await second.sqlJSON(`CREATE TABLE lazydb.public.d AS SELECT 5 AS id`);
    await second.detachDatabase('lazydb');
    const third = await open(backend, ['opfs://lazydb']);
    await third.sqlJSON(`ALTER TABLE lazydb.public.d RENAME TO datafusion.public.d_memory`);
    await third.detachDatabase('lazydb');
    await expect(third.sqlJSON(`SELECT * FROM d_memory`)).resolves.toEqual([{ id: 5 }]);
  });

  it('switches the default database with USE', async () => {
    const backend = new MemoryStorageBackend();
    const db = await open(backend);
    await db.sqlJSON(`CREATE DATABASE 'opfs://usedb'`);
    await db.sqlJSON(`USE usedb`);
    await db.sqlJSON(`CREATE TABLE things AS SELECT 1 AS id`);
    await db.sqlJSON(`CREATE SCHEMA staging`);
    await db.sqlJSON(`USE usedb.staging`);
    await db.sqlJSON(`CREATE TABLE more AS SELECT 2 AS id`);

    await expect(
      db.sqlJSON(`
        SELECT table_catalog, table_schema, table_name
        FROM information_schema.tables
        WHERE table_catalog = 'usedb' AND table_schema <> 'information_schema'
        ORDER BY table_schema, table_name
      `),
    ).resolves.toEqual([
      { table_catalog: 'usedb', table_schema: 'public', table_name: 'things' },
      { table_catalog: 'usedb', table_schema: 'staging', table_name: 'more' },
    ]);

    // Detaching the default database falls back to the original default.
    await db.sqlJSON(`DETACH usedb`);
    await db.sqlJSON(`CREATE TABLE back_in_memory AS SELECT 1 AS id`);
    await expect(
      db.sqlJSON(`
        SELECT table_catalog, table_schema FROM information_schema.tables
        WHERE table_name = 'back_in_memory'
      `),
    ).resolves.toEqual([{ table_catalog: 'datafusion', table_schema: 'public' }]);
  });

  it('exposes databases in the catalog', async () => {
    const backend = new MemoryStorageBackend();
    const db = await open(backend);
    await db.createDatabase('opfs://catdb');
    await db.sqlJSON(`CREATE TABLE catdb.public.places AS SELECT 1 AS id, ST_Point(1, 2) AS geom`);
    await db.sqlJSON(`CREATE VIEW catdb.public.place_ids AS SELECT id FROM catdb.public.places`);

    await expect(
      db.sqlJSON(`
        SELECT database_name, storage, location, schema_count, table_count
        FROM cereusdb_databases() ORDER BY database_name
      `),
    ).resolves.toEqual([
      {
        database_name: 'catdb',
        storage: 'opfs',
        location: 'opfs://catdb',
        schema_count: 1,
        table_count: 2,
      },
      // sqlJSON omits NULL values.
      { database_name: 'datafusion', storage: 'memory', schema_count: 1, table_count: 0 },
    ]);

    await db.sqlJSON(`CREATE TABLE places AS SELECT 2 AS id`);
    expect(db.tables().sort()).toEqual(['place_ids', 'places', 'places']);
    expect(db.tables({ qualified: true }).sort()).toEqual([
      'catdb.public.place_ids',
      'catdb.public.places',
      'datafusion.public.places',
    ]);
    await db.dropTable('places');

    const catalog = await db.catalog();
    const catdb = catalog.find((database) => database.name === 'catdb');
    expect(catdb).toMatchObject({ storage: 'opfs', location: 'opfs://catdb' });
    expect(catdb?.schemas).toEqual([
      {
        name: 'public',
        tables: [
          {
            name: 'place_ids',
            type: 'VIEW',
            columns: [{ name: 'id', type: 'Int64', nullable: false }],
          },
          {
            name: 'places',
            type: 'BASE TABLE',
            columns: [
              { name: 'id', type: 'Int64', nullable: false },
              expect.objectContaining({ name: 'geom', extension: 'geoarrow.wkb' }),
            ],
          },
        ],
      },
    ]);

    await expect(
      db.sqlJSON(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_catalog = 'catdb' AND table_name = 'places' ORDER BY ordinal_position
      `),
    ).resolves.toEqual([
      { column_name: 'id', data_type: 'Int64' },
      { column_name: 'geom', data_type: 'Binary' },
    ]);
  });

  it('detaches, drops, and validates database locations', async () => {
    const backend = new MemoryStorageBackend();
    const db = await open(backend);

    await expect(db.sqlJSON(`CREATE DATABASE 'opfs:/baddb'`)).rejects.toThrow(
      "use 'opfs://baddb'",
    );
    await expect(db.sqlJSON(`CREATE DATABASE opfs://baddb`)).rejects.toThrow(
      'database locations must be quoted',
    );
    await expect(db.sqlJSON(`ATTACH 'opfs://missing'`)).rejects.toThrow('does not exist');
    await expect(db.sqlJSON(`ATTACH 'memory://x'`)).rejects.toThrow(
      "No storage backend registered for 'memory://'",
    );

    await db.sqlJSON(`CREATE DATABASE 'opfs://dropdb'`);
    await expect(db.sqlJSON(`CREATE DATABASE 'opfs://dropdb'`)).rejects.toThrow(
      'already attached',
    );
    await db.sqlJSON(`CREATE DATABASE IF NOT EXISTS 'opfs://dropdb'`);
    await db.sqlJSON(`CREATE TABLE dropdb.public.t AS SELECT 1 AS id`);
    await db.sqlJSON(`DETACH dropdb`);
    await expect(db.sqlJSON(`DETACH dropdb`)).rejects.toThrow('is not attached');
    await db.sqlJSON(`DETACH IF EXISTS dropdb`);

    await expect(db.sqlJSON(`CREATE DATABASE 'opfs://dropdb'`)).rejects.toThrow(
      'already exists',
    );
    await db.sqlJSON(`CREATE DATABASE IF NOT EXISTS 'opfs://dropdb'`);
    expect(await count(db, 'dropdb.public.t')).toBe(1);

    await db.sqlJSON(`DROP DATABASE dropdb`);
    expect(backend.paths().filter((path) => path.startsWith('dropdb/'))).toEqual([]);
    await expect(db.sqlJSON(`SELECT * FROM dropdb.public.t`)).rejects.toThrow();
    await db.sqlJSON(`DROP DATABASE IF EXISTS dropdb`);

    // Dropping by location works without attaching first.
    await db.sqlJSON(`CREATE DATABASE other LOCATION 'opfs://by_location'`);
    expect(await db.listDatabases()).toContainEqual({
      name: 'other',
      storage: 'opfs',
      location: 'opfs://by_location',
      attached: true,
    });
    await db.sqlJSON(`DETACH other`);
    expect(await db.listDatabases()).toContainEqual({
      name: null,
      storage: 'opfs',
      location: 'opfs://by_location',
      attached: false,
    });
    await db.sqlJSON(`DROP DATABASE 'opfs://by_location'`);
    expect(backend.paths()).toEqual([]);
  });

  it.runIf(packageExpectations[targetPackage].hasRaster)('persists raster tables', async () => {
    const backend = new MemoryStorageBackend();
    const first = await open(backend, ['opfs://rasterdb']);
    first.registerGeoTIFF('rasterdb.public.tiles', await readFile(SAMPLE_GEOTIFF_PATH));
    await first.flush();
    const query = `
      SELECT RS_Width(raster) AS width, RS_Height(raster) AS height, RS_NumBands(raster) AS bands
      FROM rasterdb.public.tiles
    `;
    const expected = await first.sqlJSON(query);
    expect(expected).toHaveLength(1);
    await first.detachDatabase('rasterdb');

    const second = await open(backend, ['opfs://rasterdb']);
    await expect(second.sqlJSON(query)).resolves.toEqual(expected);
  });

  it('gives in-memory and persistent databases the same shape', async () => {
    const db = await open(new MemoryStorageBackend());
    await db.sqlJSON(`CREATE DATABASE scratch`);
    await db.sqlJSON(`CREATE DATABASE 'opfs://stored'`);

    // Both start with a `public` schema, so USE and two-part names work alike.
    for (const name of ['scratch', 'stored']) {
      await db.sqlJSON(`USE ${name}`);
      await db.sqlJSON(`CREATE TABLE t AS SELECT 1 AS id`);
      await db.sqlJSON(`CREATE SCHEMA ${name}.s`);
      await db.sqlJSON(`CREATE TABLE s.u AS SELECT 2 AS id`);
    }
    await db.sqlJSON(`USE datafusion`);
    const catalog = await db.catalog();
    const shape = (name: string) =>
      catalog
        .find((database) => database.name === name)
        ?.schemas.map((schema) => [schema.name, schema.tables.map((table) => table.name)]);
    expect(shape('scratch')).toEqual([
      ['public', ['t']],
      ['s', ['u']],
    ]);
    expect(shape('stored')).toEqual(shape('scratch'));
    expect(catalog.find((database) => database.name === 'scratch')).toMatchObject({
      storage: 'memory',
      location: null,
    });

    // IF NOT EXISTS leaves an existing in-memory database untouched.
    await db.sqlJSON(`CREATE DATABASE IF NOT EXISTS scratch`);
    expect(await count(db, 'scratch.public.t')).toBe(1);

    await expect(db.sqlJSON(`DETACH scratch`)).rejects.toThrow('in-memory database');
    await db.sqlJSON(`DROP DATABASE scratch`);
    expect((await db.catalog()).map((database) => database.name)).not.toContain('scratch');
  });

  it('opens a database in only one instance at a time', async () => {
    const backend = new MemoryStorageBackend();
    const first = await open(backend, ['opfs://lockdb']);
    const second = await open(backend);
    await expect(second.attachDatabase('opfs://lockdb')).rejects.toThrow(
      'already open in another CereusDB instance',
    );
    await first.detachDatabase('lockdb');
    await expect(second.attachDatabase('opfs://lockdb', { name: 'locked' })).resolves.toBe(
      'locked',
    );
  });

  it('keeps views that cannot be resolved until their dependencies exist', async () => {
    const backend = new MemoryStorageBackend();
    const first = await open(backend, ['opfs://viewdb']);
    await first.sqlJSON(`CREATE TABLE scratch_source AS SELECT 7 AS id`);
    await first.sqlJSON(
      `CREATE VIEW viewdb.public.from_memory AS SELECT id FROM datafusion.public.scratch_source`,
    );
    await first.detachDatabase('viewdb');

    const second = await open(backend);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await second.attachDatabase('opfs://viewdb');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('from_memory'));
    warn.mockRestore();

    // Listed like any other view, with its stored columns.
    await expect(
      second.sqlJSON(`
        SELECT table_name, table_type FROM information_schema.tables
        WHERE table_catalog = 'viewdb' AND table_schema = 'public'
      `),
    ).resolves.toEqual([{ table_name: 'from_memory', table_type: 'VIEW' }]);
    await expect(
      second.sqlJSON(`
        SELECT column_name FROM information_schema.columns
        WHERE table_catalog = 'viewdb' AND table_name = 'from_memory'
      `),
    ).resolves.toEqual([{ column_name: 'id' }]);
    // Queries explain why it is unavailable.
    for (const query of [
      `SELECT * FROM viewdb.public.from_memory`,
      `SELECT id FROM viewdb.public.from_memory`,
    ]) {
      await expect(second.sqlJSON(query)).rejects.toThrow('could not be restored');
    }

    // The definition is kept across writes and resolves once the table exists.
    await second.sqlJSON(`CREATE TABLE viewdb.public.other AS SELECT 1 AS id`);
    await second.detachDatabase('viewdb');
    const third = await open(backend);
    await third.sqlJSON(`CREATE TABLE scratch_source AS SELECT 7 AS id`);
    await third.attachDatabase('opfs://viewdb');
    await expect(third.sqlJSON(`SELECT * FROM viewdb.public.from_memory`)).resolves.toEqual([
      { id: 7 },
    ]);
  });

  it('drops and replaces views that cannot be resolved', async () => {
    const backend = new MemoryStorageBackend();
    const first = await open(backend, ['opfs://dropviewdb']);
    await first.sqlJSON(`CREATE TABLE gone AS SELECT 1 AS id`);
    await first.sqlJSON(`CREATE VIEW dropviewdb.public.a AS SELECT id FROM datafusion.public.gone`);
    await first.sqlJSON(`CREATE VIEW dropviewdb.public.b AS SELECT id FROM datafusion.public.gone`);
    await first.detachDatabase('dropviewdb');

    const second = await open(backend);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await second.attachDatabase('opfs://dropviewdb');
    warn.mockRestore();
    await second.sqlJSON(`DROP VIEW dropviewdb.public.a`);
    await second.sqlJSON(`CREATE OR REPLACE VIEW dropviewdb.public.b AS SELECT 2 AS id`);
    await expect(second.sqlJSON(`SELECT * FROM dropviewdb.public.b`)).resolves.toEqual([
      { id: 2 },
    ]);
    await second.detachDatabase('dropviewdb');

    const views = (await readManifest(backend, 'dropviewdb')).schemas.public.views;
    expect(Object.keys(views)).toEqual(['b']);
    expect(views.b.sql).toContain('SELECT 2 AS id');
  });
});

describe('ALTER TABLE', () => {
  it('alters tables of persistent databases and persists the result', async () => {
    const backend = new MemoryStorageBackend();
    const first = await open(backend, ['opfs://alterdb']);
    await first.sqlJSON(`
      CREATE TABLE alterdb.public.items AS
      SELECT * FROM (VALUES (1, 'a', 10.0), (2, 'b', 20.0), (4, 'd', 40.0)) AS t(id, code, price)
    `);
    await first.sqlJSON(
      `ALTER TABLE alterdb.public.items ADD COLUMN status VARCHAR DEFAULT 'new'`,
    );
    await first.sqlJSON(`ALTER TABLE alterdb.public.items RENAME COLUMN code TO label`);
    await first.sqlJSON(`ALTER TABLE alterdb.public.items DROP COLUMN price`);
    await first.sqlJSON(`ALTER TABLE alterdb.public.items RENAME TO products`);
    await first.sqlJSON(`INSERT INTO alterdb.public.products (id, label) VALUES (3, 'c')`);
    await first.detachDatabase('alterdb');

    const second = await open(backend, ['opfs://alterdb']);
    await expect(
      second.sqlJSON(`SELECT * FROM alterdb.public.products ORDER BY id`),
    ).resolves.toEqual([
      { id: 1, label: 'a', status: 'new' },
      { id: 2, label: 'b', status: 'new' },
      { id: 3, label: 'c', status: 'new' },
      { id: 4, label: 'd', status: 'new' },
    ]);
    expect(
      (await second.catalog())
        .find((database) => database.name === 'alterdb')
        ?.schemas[0]?.tables.map((table) => table.name),
    ).toEqual(['products']);
  });

  it('alters in-memory tables and validates operations', async () => {
    const db = await open(new MemoryStorageBackend());
    await db.sqlJSON(`CREATE TABLE mem_items AS SELECT 1 AS id, 'x' AS code`);
    await db.alterTable('mem_items', { addColumn: { name: 'qty', type: 'INT' } });
    await db.alterTable('mem_items', { renameColumn: { from: 'code', to: 'sku' } });
    // sqlJSON omits NULL values.
    await expect(db.sqlJSON(`SELECT * FROM mem_items`)).resolves.toEqual([{ id: 1, sku: 'x' }]);
    expect(
      (await db.catalog())[0]?.schemas[0]?.tables.find((table) => table.name === 'mem_items')
        ?.columns.map((column) => `${column.name}:${column.type}`),
    ).toEqual(['id:Int64', 'sku:Utf8', 'qty:Int32']);
    await db.alterTable('mem_items', { dropColumn: 'qty' });
    await db.alterTable('mem_items', { renameTo: 'mem_renamed' });
    await expect(db.sqlJSON(`SELECT * FROM mem_renamed`)).resolves.toEqual([
      { id: 1, sku: 'x' },
    ]);

    await expect(db.sqlJSON(`ALTER TABLE mem_renamed DROP COLUMN missing`)).rejects.toThrow(
      "Column 'missing' does not exist",
    );
    await db.sqlJSON(`ALTER TABLE mem_renamed DROP COLUMN IF EXISTS missing`);
    await expect(db.sqlJSON(`ALTER TABLE mem_renamed ADD COLUMN sku INT`)).rejects.toThrow(
      'already exists',
    );
    await expect(
      db.alterTable('mem_renamed', { dropColumn: ['id', 'sku'] }),
    ).rejects.toThrow('Cannot drop all columns');
    // A failing ALTER TABLE leaves the table unchanged.
    await expect(
      db.sqlJSON(`ALTER TABLE mem_renamed RENAME COLUMN sku TO code, DROP COLUMN missing`),
    ).rejects.toThrow("Column 'missing' does not exist");
    await expect(db.sqlJSON(`SELECT * FROM mem_renamed`)).resolves.toEqual([
      { id: 1, sku: 'x' },
    ]);
    await expect(
      db.sqlJSON(`ALTER TABLE mem_renamed ADD COLUMN required INT NOT NULL`),
    ).rejects.toThrow('without a DEFAULT');
    await expect(db.sqlJSON(`ALTER TABLE missing_table RENAME TO x`)).rejects.toThrow(
      'not found',
    );
    await db.sqlJSON(`ALTER TABLE IF EXISTS missing_table RENAME TO x`);
  });

  it('moves tables between databases with RENAME TO', async () => {
    const backend = new MemoryStorageBackend();
    const db = await open(backend, ['opfs://movedb']);
    await db.sqlJSON(`CREATE TABLE loose AS SELECT 5 AS id`);
    await db.sqlJSON(`ALTER TABLE loose RENAME TO movedb.public.kept`);
    await db.sqlJSON(`CREATE TABLE movedb.public.leaving AS SELECT 6 AS id`);
    await db.sqlJSON(`ALTER TABLE movedb.public.leaving RENAME TO datafusion.public.left_behind`);
    await db.detachDatabase('movedb');

    await expect(db.sqlJSON(`SELECT * FROM left_behind`)).resolves.toEqual([{ id: 6 }]);
    const reopened = await open(backend, ['opfs://movedb']);
    await expect(reopened.sqlJSON(`SELECT * FROM movedb.public.kept`)).resolves.toEqual([
      { id: 5 },
    ]);
    await expect(reopened.sqlJSON(`SELECT * FROM movedb.public.leaving`)).rejects.toThrow();
  });
});

describe('programmatic database API', () => {
  it('creates, alters, inserts into and drops tables', async () => {
    const backend = new MemoryStorageBackend();
    const db = await open(backend);
    await expect(db.createDatabase('opfs://AppData')).resolves.toBe('appdata');
    await db.useDatabase('appdata');
    await db.createTable('events', { columns: { id: 'INT', kind: 'VARCHAR', score: 'DOUBLE' } });
    await db.createTable('events_copy', { as: 'SELECT * FROM events' });
    await db.createTable('events', { columns: { other: 'INT' } }, { ifNotExists: true });

    const arrow = tableFromArrays({
      id: Int32Array.from([1, 2, 3]),
      kind: ['click', 'view', 'click'],
    });
    await expect(db.insertArrow('events', tableToIPC(arrow, 'stream'))).resolves.toBe(3);
    await expect(db.insertArrow('appdata.public.events', tableToIPC(arrow, 'file'))).resolves.toBe(
      3,
    );
    await expect(
      db.insertArrow('events', tableToIPC(tableFromArrays({ nope: [1] }), 'stream')),
    ).rejects.toThrow("Column 'nope' does not exist");

    await db.alterTable('events', {
      addColumn: { name: 'source', type: 'VARCHAR', default: "'web'" },
    });
    await db.dropTable('events_copy');
    await db.detachDatabase('appdata');

    const reopened = await open(backend, ['opfs://AppData']);
    await expect(
      reopened.sqlJSON(`
        SELECT kind, COUNT(*) AS n, MIN(source) AS source, MAX(score) AS score
        FROM appdata.public.events GROUP BY kind ORDER BY kind
      `),
    ).resolves.toEqual([
      // score is NULL everywhere (sqlJSON omits NULL values).
      { kind: 'click', n: 4, source: 'web' },
      { kind: 'view', n: 2, source: 'web' },
    ]);
    expect(reopened.tables()).not.toContain('events_copy');

    await reopened.dropDatabase('appdata');
    expect(backend.paths()).toEqual([]);
  });

  it('persists tables registered from files and GeoJSON', async () => {
    const backend = new MemoryStorageBackend();
    const db = await open(backend, ['opfs://filedb']);
    db.registerGeoJSON('filedb.public.features', {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'a' }, geometry: { type: 'Point', coordinates: [1, 2] } },
      ],
    });
    await db.flush();
    await db.detachDatabase('filedb');

    const reopened = await open(backend, ['opfs://filedb']);
    await expect(
      reopened.sqlJSON(
        `SELECT ST_AsText(ST_GeomFromWKT(geometry)) AS wkt, properties FROM filedb.public.features`,
      ),
    ).resolves.toEqual([{ wkt: 'POINT(1 2)', properties: '{"name":"a"}' }]);
  });
});

describe('OPFSStorageBackend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores databases in the origin private file system', async () => {
    const opfs = createFakeOPFS();
    vi.stubGlobal('navigator', opfs.navigator);
    expect(OPFSStorageBackend.isSupported()).toBe(true);

    const first = await CereusDB.create({ wasmSource: wasmBytes });
    await first.sqlJSON(`CREATE DATABASE 'opfs://browserdb'`);
    await first.sqlJSON(`CREATE TABLE browserdb.public.t AS SELECT 1 AS id, 'one' AS label`);
    await first.sqlJSON(`INSERT INTO browserdb.public.t VALUES (2, 'two')`);
    expect(opfs.paths()).toEqual([
      'cereusdb/browserdb/manifest.json',
      expect.stringMatching(/^cereusdb\/browserdb\/segments\/\d+\.arrow$/),
      expect.stringMatching(/^cereusdb\/browserdb\/segments\/\d+\.arrow$/),
    ]);

    // A second instance cannot open it while the first holds the Web Lock.
    const second = await CereusDB.create({ wasmSource: wasmBytes });
    await expect(second.sqlJSON(`ATTACH 'opfs://browserdb'`)).rejects.toThrow(
      'open in another tab or worker',
    );
    await first.detachDatabase('browserdb');

    await second.sqlJSON(`ATTACH 'opfs://browserdb'`);
    await expect(
      second.sqlJSON(`SELECT * FROM browserdb.public.t ORDER BY id`),
    ).resolves.toEqual([
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
    ]);
    expect(await second.listDatabases()).toContainEqual({
      name: 'browserdb',
      storage: 'opfs',
      location: 'opfs://browserdb',
      attached: true,
    });

    await second.sqlJSON(`DROP DATABASE browserdb`);
    expect(opfs.paths()).toEqual([]);
  });

  it('is not used when OPFS is unavailable or disabled', async () => {
    const db = await CereusDB.create({ wasmSource: wasmBytes, storage: { opfs: false } });
    await expect(db.sqlJSON(`CREATE DATABASE 'opfs://nope'`)).rejects.toThrow(
      'OPFS is not available',
    );
  });
});
