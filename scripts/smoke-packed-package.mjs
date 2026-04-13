import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const PACKAGE_VARIANTS = ['minimal', 'standard', 'global', 'full'];
const PACKAGE_VARIANT_SET = new Set(PACKAGE_VARIANTS);
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const TAR = process.platform === 'win32' ? 'tar.exe' : 'tar';

const requestedVariants = process.argv.slice(2);
const variants =
  requestedVariants.length === 0 ||
  (requestedVariants.length === 1 && requestedVariants[0] === 'all')
    ? PACKAGE_VARIANTS
    : requestedVariants;

for (const variant of variants) {
  if (!PACKAGE_VARIANT_SET.has(variant)) {
    throw new Error(
      `Unsupported package variant: ${variant}. Expected one of ${PACKAGE_VARIANTS.join(', ')}, or "all".`,
    );
  }
}

for (const variant of variants) {
  await smokePackedPackage(variant);
}

async function smokePackedPackage(variant) {
  const packageDir = resolve(REPO_ROOT, 'packages', variant);
  const tempRoot = await mkdtemp(join(tmpdir(), `cereusdb-${variant}-pack-`));
  const tarballDir = resolve(tempRoot, 'tarball');
  const extractDir = resolve(tempRoot, 'extract');
  const npmCacheDir = resolve(tempRoot, 'npm-cache');

  await mkdir(tarballDir, { recursive: true });
  await mkdir(extractDir, { recursive: true });
  await mkdir(npmCacheDir, { recursive: true });

  try {
    const packOutput = execFileSync(
      NPM,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballDir],
      {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_cache: npmCacheDir,
        },
      },
    );
    const packResult = JSON.parse(packOutput);

    if (!Array.isArray(packResult) || packResult.length !== 1 || !packResult[0]?.filename) {
      throw new Error(`Unexpected npm pack output for ${variant}: ${packOutput}`);
    }

    const tarballPath = resolve(tarballDir, packResult[0].filename);
    execFileSync(TAR, ['-xzf', tarballPath, '-C', extractDir], { cwd: REPO_ROOT });

    const packedRoot = resolve(extractDir, 'package');
    const packageEntry = resolve(packedRoot, 'dist', 'index.js');
    const wasmPath = resolve(packedRoot, 'dist', 'wasm', 'cereusdb_bg.wasm');
    const moduleUrl = `${pathToFileURL(packageEntry).href}?smoke=${variant}-${Date.now()}`;

    const { CereusDB } = await import(moduleUrl);
    const db = await CereusDB.create({
      wasmSource: await readFile(wasmPath),
    });
    const rows = await db.sqlJSON('SELECT 1 AS smoke_test');

    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error(`Expected one smoke-test row for ${variant}, received ${JSON.stringify(rows)}`);
    }

    const row = rows[0];
    if (!row || typeof row !== 'object' || !('smoke_test' in row) || Number(row.smoke_test) !== 1) {
      throw new Error(`Unexpected smoke-test payload for ${variant}: ${JSON.stringify(row)}`);
    }

    process.stdout.write(`Packed @cereusdb/${variant} passed init smoke test\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
