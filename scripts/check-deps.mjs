// Validates deps/versions.env against the submodule gitlinks and toolchain pins.
//
// Usage: node scripts/check-deps.mjs [--remote]
//   --remote  resolve every <NAME>_TAG upstream instead of trusting local tags

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const VERSIONS_PATH = resolve(REPO_ROOT, 'deps', 'versions.env');
const RUST_TOOLCHAIN_PATH = resolve(REPO_ROOT, 'rust-toolchain.toml');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github', 'workflows');

const checkRemote = process.argv.includes('--remote');
const errors = [];

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: REPO_ROOT });
  return stdout.trim();
}

async function readVersions() {
  const versions = new Map();
  const lines = (await readFile(VERSIONS_PATH, 'utf8')).split('\n');

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      return;
    }

    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=([^\s"'$`]+)$/);
    if (!match) {
      errors.push(`deps/versions.env:${index + 1}: expected KEY=value, got "${trimmed}"`);
      return;
    }

    const [, key, value] = match;
    if (versions.has(key)) {
      errors.push(`deps/versions.env:${index + 1}: duplicate key ${key}`);
    }
    versions.set(key, value);
  });

  return versions;
}

async function readSubmodules() {
  const output = await git(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$']);
  const byName = new Map();

  for (const line of output.split('\n')) {
    const [key, value] = line.split(/\s+/, 2);
    const [, name, field] = key.match(/^submodule\.(.+)\.(path|url)$/);
    byName.set(name, { ...byName.get(name), [field]: value });
  }

  return [...byName.values()].filter((submodule) => submodule.path.startsWith('deps/'));
}

function keyPrefix(path) {
  return basename(path).toUpperCase().replaceAll('-', '_');
}

async function gitlinkCommit(path) {
  // The index (not HEAD) so a staged bump is checked before it is committed.
  const output = await git(['ls-files', '--stage', '--', path]);
  const match = output.match(/^160000 ([0-9a-f]{40}) /);
  return match ? match[1] : undefined;
}

async function checkedOutCommit(path) {
  if (!existsSync(resolve(REPO_ROOT, path, '.git'))) {
    return undefined;
  }
  return git(['-C', path, 'rev-parse', 'HEAD']);
}

async function localTagCommit(path, tag) {
  if (!existsSync(resolve(REPO_ROOT, path, '.git'))) {
    return undefined;
  }
  try {
    return await git(['-C', path, 'rev-parse', '--quiet', '--verify', `refs/tags/${tag}^{commit}`]);
  } catch {
    return undefined;
  }
}

async function remoteTagCommit(url, tag) {
  const { stdout } = await execFileAsync('git', [
    'ls-remote',
    url,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const refs = new Map(
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t').reverse()),
  );
  // Annotated tags list the peeled commit under ^{}; lightweight tags only have the ref.
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
}

async function checkSubmodules(versions) {
  const submodules = await readSubmodules();
  const expectedKeys = new Set();

  for (const { path, url } of submodules) {
    const prefix = keyPrefix(path);
    const tagKey = `${prefix}_TAG`;
    const commitKey = `${prefix}_COMMIT`;
    expectedKeys.add(tagKey);
    expectedKeys.add(commitKey);

    const tag = versions.get(tagKey);
    const pinnedCommit = versions.get(commitKey);
    if (tag && pinnedCommit) {
      errors.push(`${path}: set either ${tagKey} or ${commitKey} in deps/versions.env, not both`);
      continue;
    }
    if (!tag && !pinnedCommit) {
      errors.push(`${path}: missing ${tagKey} (or ${commitKey} if untagged) in deps/versions.env`);
      continue;
    }

    let expected = pinnedCommit;
    let pin = `${commitKey}=${pinnedCommit}`;
    if (tag) {
      // Shallow CI checkouts have no tags, so fall back to asking upstream.
      expected = checkRemote
        ? await remoteTagCommit(url, tag)
        : (await localTagCommit(path, tag)) ?? (await remoteTagCommit(url, tag));
      pin = `${tagKey}=${tag} (${expected ?? 'tag not found upstream'})`;
      if (!expected) {
        errors.push(`${path}: tag ${tag} not found in ${url}`);
        continue;
      }
    }

    const gitlink = await gitlinkCommit(path);
    if (gitlink !== expected) {
      errors.push(`${path}: gitlink is ${gitlink ?? '(none)'} but ${pin}`);
    }

    const checkedOut = await checkedOutCommit(path);
    if (checkedOut !== undefined && checkedOut !== expected) {
      errors.push(`${path}: checked out at ${checkedOut} but ${pin} (run git submodule update ${path})`);
    }
  }

  for (const key of versions.keys()) {
    if (/_(COMMIT|TAG)$/.test(key) && !expectedKeys.has(key)) {
      errors.push(`deps/versions.env: ${key} does not match any submodule under deps/`);
    }
  }

  return submodules.length;
}

async function checkRustToolchain() {
  const toolchain = await readFile(RUST_TOOLCHAIN_PATH, 'utf8');
  const channel = toolchain.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];

  for (const file of await readdir(WORKFLOWS_DIR)) {
    const workflow = await readFile(resolve(WORKFLOWS_DIR, file), 'utf8');
    for (const [, version] of workflow.matchAll(/dtolnay\/rust-toolchain@([^\s]+)/g)) {
      if (version !== channel) {
        errors.push(`.github/workflows/${file}: rust-toolchain@${version} but rust-toolchain.toml has ${channel}`);
      }
    }
  }
}

const versions = await readVersions();
const submoduleCount = await checkSubmodules(versions);
await checkRustToolchain();

if (errors.length > 0) {
  console.error(`check-deps: ${errors.length} problem(s)`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(`check-deps: ${submoduleCount} submodules match deps/versions.env${checkRemote ? ' (tags resolved upstream)' : ''}`);
