import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const PACKAGE_VARIANTS = new Set(['minimal', 'standard', 'global', 'full']);
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
const wasmSourceDir = resolve(REPO_ROOT, 'dist', variant);
const packageDir = resolve(REPO_ROOT, 'packages', variant);
const packageDistDir = resolve(packageDir, 'dist');
const packageWasmDir = resolve(packageDistDir, 'wasm');

const indexSource = await readFile(sourceIndexPath, 'utf8');
const packageIndex = indexSource.replaceAll('../../pkg/cereusdb.js', './wasm/cereusdb.js');

if (!packageIndex.includes("./wasm/cereusdb.js")) {
  throw new Error('Failed to rewrite wrapper import to packaged wasm path');
}

await rm(packageDistDir, { recursive: true, force: true });
await mkdir(packageWasmDir, { recursive: true });

await writeFile(resolve(packageDistDir, 'index.js'), packageIndex);
await copyFile(sourceTypesPath, resolve(packageDistDir, 'index.d.ts'));

for (const filename of WASM_FILES) {
  await copyFile(resolve(wasmSourceDir, filename), resolve(packageWasmDir, filename));
}

console.log(`Packaged @cereusdb/${variant} from dist/${variant}`);
