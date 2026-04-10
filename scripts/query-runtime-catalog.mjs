import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageDir = process.argv[2];

if (!packageDir) {
  process.stderr.write('Usage: node scripts/query-runtime-catalog.mjs <package-dir>\n');
  process.exit(1);
}

const modulePath = resolve(packageDir, 'cereusdb.js');
const wasmPath = resolve(packageDir, 'cereusdb_bg.wasm');

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

console.log = (...args) => {
  process.stderr.write(`${args.join(' ')}\n`);
};
console.warn = (...args) => {
  process.stderr.write(`${args.join(' ')}\n`);
};

try {
  const moduleUrl = `${pathToFileURL(modulePath).href}?surface=${Date.now()}`;
  const { initSync, CereusDB } = await import(moduleUrl);

  initSync({ module: readFileSync(wasmPath) });

  const db = CereusDB.create();
  const json = await db.sql_json(
    "SELECT DISTINCT routine_name FROM information_schema.routines WHERE LEFT(routine_name, 3) = 'st_' OR LEFT(routine_name, 3) = 'rs_' ORDER BY routine_name",
  );
  const rows = JSON.parse(json);

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        packageDir: resolve(packageDir),
        routines: rows.map((row) => String(row.routine_name)),
      },
      null,
      2,
    ),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: false,
        packageDir: resolve(packageDir),
        error: {
          name: error?.name ?? 'Error',
          message: error?.message ?? String(error),
          stack: error?.stack ?? '',
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
}
