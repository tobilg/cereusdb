import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const CARGO_TOML_PATH = resolve(REPO_ROOT, 'Cargo.toml');
const PACKAGE_JSONS = [
  resolve(REPO_ROOT, 'packages', 'minimal', 'package.json'),
  resolve(REPO_ROOT, 'packages', 'standard', 'package.json'),
  resolve(REPO_ROOT, 'packages', 'global', 'package.json'),
  resolve(REPO_ROOT, 'packages', 'full', 'package.json'),
  resolve(REPO_ROOT, 'packages', 'documentation', 'package.json'),
  resolve(REPO_ROOT, 'packages', 'playground', 'package.json'),
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

for (const packageJsonPath of PACKAGE_JSONS) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  packageJson.version = version;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

console.log(`Synced package versions to ${version}`);
