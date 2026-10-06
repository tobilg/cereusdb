import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const PACKAGE_VARIANTS = new Set(['minimal', 'standard', 'global', 'full']);
const DEFAULT_WASM_URL_FALLBACK = "module_or_path = new URL('cereusdb_bg.wasm', import.meta.url);";
const EXTERNAL_WASM_URL_FALLBACK =
  "throw new Error('@cereusdb external entry requires CereusDB.create({ wasmUrl }) or CereusDB.create({ wasmSource })');";
const WASM_FILES = [
  'cereusdb.js',
  'cereusdb.d.ts',
  'cereusdb_bg.wasm',
  'cereusdb_bg.wasm.d.ts',
  'env_shim.js',
];

const variant = process.argv[2];

if (!PACKAGE_VARIANTS.has(variant)) {
  throw new Error(`Unsupported package variant: ${variant}`);
}

const sourceIndexPath = resolve(REPO_ROOT, 'js', 'dist', 'index.js');
const sourceTypesPath = resolve(REPO_ROOT, 'js', 'dist', 'index.d.ts');
// Other wrapper modules imported by index.js (same directory in the package).
const WRAPPER_MODULES = ['storage.js', 'storage.d.ts'];
const wasmSourceDir = resolve(REPO_ROOT, 'dist', variant);
const packageDir = resolve(REPO_ROOT, 'packages', variant);
const packageDistDir = resolve(packageDir, 'dist');
const packageWasmDir = resolve(packageDistDir, 'wasm');

const indexSource = await readFile(sourceIndexPath, 'utf8');
const packageIndex = indexSource.replaceAll('../../pkg/cereusdb.js', './wasm/cereusdb.js');

if (!packageIndex.includes("./wasm/cereusdb.js")) {
  throw new Error('Failed to rewrite wrapper import to packaged wasm path');
}

// The external entry uses a loader without the default `new URL(..., import.meta.url)`
// reference, so bundlers do not emit or inline the wasm when callers provide it themselves.
const externalIndex = packageIndex.replaceAll('./wasm/cereusdb.js', './wasm/cereusdb-external.js');
const loaderSource = await readFile(resolve(wasmSourceDir, 'cereusdb.js'), 'utf8');

if (loaderSource.split(DEFAULT_WASM_URL_FALLBACK).length !== 2) {
  throw new Error('Expected exactly one default wasm URL fallback in cereusdb.js');
}

const externalLoader = loaderSource.replace(DEFAULT_WASM_URL_FALLBACK, EXTERNAL_WASM_URL_FALLBACK);

if (externalLoader.includes('cereusdb_bg.wasm')) {
  throw new Error('External loader still references cereusdb_bg.wasm');
}

await rm(packageDistDir, { recursive: true, force: true });
await mkdir(packageWasmDir, { recursive: true });

await writeFile(resolve(packageDistDir, 'index.js'), packageIndex);
await copyFile(sourceTypesPath, resolve(packageDistDir, 'index.d.ts'));
await writeFile(resolve(packageDistDir, 'external.js'), externalIndex);
await copyFile(sourceTypesPath, resolve(packageDistDir, 'external.d.ts'));
for (const filename of WRAPPER_MODULES) {
  await copyFile(resolve(REPO_ROOT, 'js', 'dist', filename), resolve(packageDistDir, filename));
}

for (const filename of WASM_FILES) {
  await copyFile(resolve(wasmSourceDir, filename), resolve(packageWasmDir, filename));
}

await writeFile(resolve(packageWasmDir, 'cereusdb-external.js'), externalLoader);
await copyFile(
  resolve(wasmSourceDir, 'cereusdb.d.ts'),
  resolve(packageWasmDir, 'cereusdb-external.d.ts'),
);

try {
  await cp(resolve(wasmSourceDir, 'snippets'), resolve(packageWasmDir, 'snippets'), {
    recursive: true,
    force: true,
  });
} catch (error) {
  if (error?.code !== 'ENOENT') {
    throw error;
  }
}

console.log(`Packaged @cereusdb/${variant} from dist/${variant}`);
