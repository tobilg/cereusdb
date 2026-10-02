import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const PACKAGE_VARIANTS = ['minimal', 'standard', 'global', 'full'];
// jsDelivr refuses to serve npm files larger than 50 MB, which breaks the
// default wasm loader for anyone importing the package from that CDN.
const MAX_WASM_BYTES = 50_000_000;
const arg = process.argv[2] ?? 'all';
const variants = arg === 'all' ? PACKAGE_VARIANTS : [arg];

for (const variant of variants) {
  if (!PACKAGE_VARIANTS.includes(variant)) {
    throw new Error(`Unsupported package variant: ${variant}`);
  }
}

function normalize(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalize(entry)]),
    );
  }

  return value;
}

function assertRows(actual, expected, description) {
  const normalizedActual = normalize(actual);
  const normalizedExpected = normalize(expected);

  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(
      `${description} returned ${JSON.stringify(normalizedActual)} instead of ${JSON.stringify(normalizedExpected)}`,
    );
  }
}

async function runQuery(db, sql, expected, description) {
  const rows = await db.sqlJSON(sql);
  assertRows(rows, expected, description);
}

async function packPackage(packageDir, tempDir) {
  const npmCacheDir = resolve(tempDir, 'npm-cache');
  await mkdir(npmCacheDir);
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', tempDir],
    {
      cwd: packageDir,
      env: {
        ...process.env,
        npm_config_cache: npmCacheDir,
      },
    },
  );
  const output = JSON.parse(stdout.trim());

  if (!Array.isArray(output) || output.length === 0 || typeof output[0]?.filename !== 'string') {
    throw new Error(`Unexpected npm pack output: ${stdout}`);
  }

  return resolve(tempDir, output[0].filename);
}

async function unpackTarball(tarballPath, targetDir) {
  await execFileAsync('tar', ['-xzf', tarballPath, '-C', targetDir]);
}

async function smokeExternalEntry(variant, packageRoot, wasmSource) {
  const externalLoader = await readFile(
    resolve(packageRoot, 'dist', 'wasm', 'cereusdb-external.js'),
    'utf8',
  );

  if (externalLoader.includes('cereusdb_bg.wasm')) {
    throw new Error(`${variant} external loader still references cereusdb_bg.wasm`);
  }

  const externalUrl = pathToFileURL(resolve(packageRoot, 'dist', 'external.js')).href;
  const { CereusDB } = await import(externalUrl);

  let missingSourceError;
  try {
    await CereusDB.create();
  } catch (error) {
    missingSourceError = error;
  }

  if (!String(missingSourceError?.message).includes('requires CereusDB.create({ wasmUrl })')) {
    throw new Error(`${variant} external entry did not reject create() without a wasm source`);
  }

  const db = await CereusDB.create({ wasmSource });
  await runQuery(db, 'SELECT 1 AS ok', [{ ok: 1 }], `${variant} external SELECT 1`);
}

async function smokeVariant(variant) {
  const packageDir = resolve(REPO_ROOT, 'packages', variant);
  const packageIndex = resolve(packageDir, 'dist', 'index.js');
  const tempDir = await mkdtemp(resolve(tmpdir(), `cereusdb-smoke-${variant}-`));

  try {
    await access(packageIndex);

    const tarballPath = await packPackage(packageDir, tempDir);
    const unpackDir = resolve(tempDir, 'unpacked');
    await mkdir(unpackDir);
    await unpackTarball(tarballPath, unpackDir);

    const packageRoot = resolve(unpackDir, 'package');
    const wasmPath = resolve(packageRoot, 'dist', 'wasm', 'cereusdb_bg.wasm');
    const { size: wasmBytes } = await stat(wasmPath);
    if (wasmBytes > MAX_WASM_BYTES) {
      throw new Error(
        `${variant} wasm is ${wasmBytes} bytes, above the ${MAX_WASM_BYTES}-byte limit that CDNs such as jsDelivr enforce`,
      );
    }
    const moduleUrl = pathToFileURL(resolve(packageRoot, 'dist', 'index.js')).href;
    const { CereusDB } = await import(moduleUrl);
    const wasmSource = await readFile(wasmPath);
    const db = await CereusDB.create({ wasmSource });
    const { version: packageVersion } = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    );
    const expectedVersion = `CereusDB ${packageVersion}`;

    if (db.version() !== expectedVersion) {
      throw new Error(
        `${variant} runtime reports "${db.version()}" but package version is "${expectedVersion}"`,
      );
    }

    await runQuery(db, 'SELECT 1 AS ok', [{ ok: 1 }], `${variant} SELECT 1`);
    await runQuery(
      db,
      'CREATE TABLE smoke_table (id INT, name VARCHAR)',
      [],
      `${variant} CREATE TABLE`,
    );
    await runQuery(
      db,
      'CREATE TABLE IF NOT EXISTS smoke_table (ignored INT)',
      [],
      `${variant} CREATE TABLE IF NOT EXISTS`,
    );
    await runQuery(
      db,
      'SELECT COUNT(*) AS row_count FROM smoke_table',
      [{ row_count: 0 }],
      `${variant} empty table count`,
    );
    await runQuery(
      db,
      `
        CREATE OR REPLACE TABLE smoke_table AS
        SELECT * FROM (VALUES
          (1, 'alpha'),
          (2, 'beta')
        ) AS t(id, name)
      `,
      [],
      `${variant} CREATE OR REPLACE TABLE`,
    );
    await runQuery(
      db,
      'SELECT id, name FROM smoke_table ORDER BY id',
      [
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ],
      `${variant} replaced table rows`,
    );
    await runQuery(
      db,
      'CREATE VIEW smoke_view AS SELECT COUNT(*) AS row_count FROM smoke_table',
      [],
      `${variant} CREATE VIEW`,
    );
    await runQuery(
      db,
      'SELECT row_count FROM smoke_view',
      [{ row_count: 2 }],
      `${variant} view query`,
    );
    await runQuery(
      db,
      'CREATE OR REPLACE VIEW smoke_view AS SELECT MAX(id) AS max_id FROM smoke_table',
      [],
      `${variant} CREATE OR REPLACE VIEW`,
    );
    await runQuery(
      db,
      'SELECT max_id FROM smoke_view',
      [{ max_id: 2 }],
      `${variant} replaced view query`,
    );
    await runQuery(db, 'DROP VIEW smoke_view', [], `${variant} DROP VIEW`);
    await runQuery(db, 'DROP VIEW IF EXISTS smoke_view', [], `${variant} DROP VIEW IF EXISTS`);
    await runQuery(db, 'CREATE SCHEMA smoke_schema', [], `${variant} CREATE SCHEMA`);
    await runQuery(
      db,
      `
        CREATE TABLE smoke_schema.schema_table AS
        SELECT * FROM (VALUES
          (3, 'gamma')
        ) AS t(id, name)
      `,
      [],
      `${variant} schema-qualified CREATE TABLE`,
    );
    await runQuery(
      db,
      'SELECT id, name FROM smoke_schema.schema_table',
      [{ id: 3, name: 'gamma' }],
      `${variant} schema-qualified SELECT`,
    );
    await runQuery(
      db,
      'DROP TABLE smoke_schema.schema_table',
      [],
      `${variant} schema-qualified DROP TABLE`,
    );
    await runQuery(db, 'DROP SCHEMA smoke_schema', [], `${variant} DROP SCHEMA`);
    await runQuery(db, 'DROP SCHEMA IF EXISTS smoke_schema', [], `${variant} DROP SCHEMA IF EXISTS`);
    await runQuery(db, 'CREATE DATABASE smoke_catalog', [], `${variant} CREATE DATABASE`);
    await runQuery(
      db,
      'CREATE SCHEMA smoke_catalog.smoke_schema',
      [],
      `${variant} catalog-qualified CREATE SCHEMA`,
    );
    await runQuery(
      db,
      `
        CREATE TABLE smoke_catalog.smoke_schema.catalog_table AS
        SELECT * FROM (VALUES
          (4, 'delta')
        ) AS t(id, name)
      `,
      [],
      `${variant} catalog-qualified CREATE TABLE`,
    );
    await runQuery(
      db,
      'SELECT id, name FROM smoke_catalog.smoke_schema.catalog_table',
      [{ id: 4, name: 'delta' }],
      `${variant} catalog-qualified SELECT`,
    );
    await runQuery(
      db,
      'DROP TABLE smoke_catalog.smoke_schema.catalog_table',
      [],
      `${variant} catalog-qualified DROP TABLE`,
    );
    await runQuery(
      db,
      'DROP SCHEMA smoke_catalog.smoke_schema',
      [],
      `${variant} catalog-qualified DROP SCHEMA`,
    );
    await runQuery(db, 'DROP TABLE smoke_table', [], `${variant} DROP TABLE`);
    await runQuery(db, 'DROP TABLE IF EXISTS smoke_table', [], `${variant} DROP TABLE IF EXISTS`);

    await smokeExternalEntry(variant, packageRoot, wasmSource);

    console.log(`[smoke] ${variant}: ok`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

for (const variant of variants) {
  await smokeVariant(variant);
}
