import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

console.log = (...args) => {
  process.stderr.write(`${args.join(' ')}\n`);
};
console.warn = (...args) => {
  process.stderr.write(`${args.join(' ')}\n`);
};

const supportDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(supportDir, '..', '..', '..');
const selectedPackage = process.env.CEREUSDB_PACKAGE ?? process.env.SEDONA_WASM_PACKAGE;
const pkgDir = selectedPackage ? resolve(repoRoot, 'dist', selectedPackage) : resolve(repoRoot, 'pkg');
const wasmPath = resolve(pkgDir, 'cereusdb_bg.wasm');
const { initSync, CereusDB } = await import(pathToFileURL(resolve(pkgDir, 'cereusdb.js')).href);

const mode = process.argv[2];
const query = process.argv[3];
const routinePrefix = process.argv[3];

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

try {
  initSync({ module: readFileSync(wasmPath) });
  const db = CereusDB.create();

  if (mode === 'list-functions') {
    const prefix = routinePrefix ?? 'st_';
    const json = await db.sql_json(
      `SELECT routine_name FROM information_schema.routines WHERE LEFT(routine_name, ${prefix.length}) = '${prefix}' ORDER BY routine_name`,
    );
    const rows = JSON.parse(json);
    emit({
      ok: true,
      data: rows.map((row) => String(row.routine_name)),
    });
  } else if (mode === 'query') {
    const json = await db.sql_json(query);
    emit({
      ok: true,
      data: JSON.parse(json),
    });
  } else {
    throw new Error(`Unsupported mode: ${mode}`);
  }
} catch (error) {
  emit({
    ok: false,
    error: {
      name: error?.name ?? 'Error',
      message: error?.message ?? String(error),
      stack: error?.stack ?? '',
    },
  });

  if (mode === 'list-functions') {
    process.exitCode = 1;
  }
} finally {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
}
