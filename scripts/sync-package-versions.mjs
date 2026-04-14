import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const CARGO_TOML_PATH = resolve(REPO_ROOT, 'Cargo.toml');
const PACKAGE_MANIFESTS = [
  { path: resolve(REPO_ROOT, 'js', 'package.json') },
  { path: resolve(REPO_ROOT, 'packages', 'minimal', 'package.json') },
  { path: resolve(REPO_ROOT, 'packages', 'standard', 'package.json') },
  { path: resolve(REPO_ROOT, 'packages', 'global', 'package.json') },
  { path: resolve(REPO_ROOT, 'packages', 'full', 'package.json') },
  { path: resolve(REPO_ROOT, 'packages', 'documentation', 'package.json') },
  { path: resolve(REPO_ROOT, 'packages', 'playground', 'package.json') },
  {
    path: resolve(REPO_ROOT, 'packages', 'simple-html', 'package.json'),
    update(packageJson, version) {
      packageJson.dependencies ??= {};
      packageJson.dependencies['@cereusdb/minimal'] = `^${version}`;
    },
  },
];
const LOCKFILE_UPDATES = [
  {
    path: resolve(REPO_ROOT, 'js', 'package-lock.json'),
  },
  {
    path: resolve(REPO_ROOT, 'packages', 'simple-html', 'package-lock.json'),
    update(lockfile, version) {
      lockfile.packages ??= {};
      lockfile.packages[''] ??= {};
      lockfile.packages[''].dependencies ??= {};
      lockfile.packages[''].dependencies['@cereusdb/minimal'] = `^${version}`;
    },
  },
];

function parseArgs(argv) {
  const args = { version: undefined, suffix: '' };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--version') {
      args.version = argv[i + 1];
      i += 1;
    } else if (arg === '--suffix') {
      args.suffix = argv[i + 1] ?? '';
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function extractWorkspaceVersion(cargoToml) {
  const workspaceMatch = cargoToml.match(/\[workspace\.package\][\s\S]*?version = "([^"]+)"/);

  if (!workspaceMatch) {
    throw new Error('Could not read workspace.package.version from Cargo.toml');
  }

  return workspaceMatch[1];
}

const args = parseArgs(process.argv);
const cargoToml = await readFile(CARGO_TOML_PATH, 'utf8');
const baseVersion = extractWorkspaceVersion(cargoToml);
const version = args.version ?? `${baseVersion}${args.suffix}`;

for (const manifest of PACKAGE_MANIFESTS) {
  const packageJson = JSON.parse(await readFile(manifest.path, 'utf8'));
  packageJson.version = version;
  manifest.update?.(packageJson, version);
  await writeFile(manifest.path, `${JSON.stringify(packageJson, null, 2)}\n`);
}

for (const lockfileUpdate of LOCKFILE_UPDATES) {
  const lockfile = JSON.parse(await readFile(lockfileUpdate.path, 'utf8'));
  lockfile.version = version;
  lockfile.packages ??= {};
  lockfile.packages[''] ??= {};
  lockfile.packages[''].version = version;
  lockfileUpdate.update?.(lockfile, version);
  await writeFile(lockfileUpdate.path, `${JSON.stringify(lockfile, null, 2)}\n`);
}

console.log(`Synced package versions to ${version}`);
