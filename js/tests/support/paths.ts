import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SELECTED_PACKAGE = process.env.CEREUSDB_PACKAGE ?? process.env.SEDONA_WASM_PACKAGE;

export const JS_DIR = resolve(THIS_DIR, '..', '..');
export const REPO_ROOT = resolve(JS_DIR, '..');
export const PKG_DIR = SELECTED_PACKAGE
  ? resolve(REPO_ROOT, 'dist', SELECTED_PACKAGE)
  : resolve(REPO_ROOT, 'pkg');
export const DOCS_SQL_DIR = resolve(REPO_ROOT, 'deps', 'sedona-db', 'docs', 'reference', 'sql');
export const RUNNER_PATH = resolve(JS_DIR, 'tests', 'support', 'run-wasm-query.mjs');
export const WASM_PATH = resolve(PKG_DIR, 'cereusdb_bg.wasm');
export const SAMPLE_PARQUET_PATH = resolve(
  REPO_ROOT,
  'deps',
  'sedona-db',
  'r',
  'sedonadb',
  'inst',
  'files',
  'natural-earth_cities_geo.parquet',
);
export const SAMPLE_GEOTIFF_PATH = resolve(
  REPO_ROOT,
  'deps',
  'sedona-db',
  'submodules',
  'sedona-testing',
  'data',
  'raster',
  'test4.tiff',
);
