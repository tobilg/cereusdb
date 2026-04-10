import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const docsDir = resolve(repoRoot, 'deps', 'sedona-db', 'docs', 'reference', 'sql');
const queryScript = resolve(scriptDir, 'query-runtime-catalog.mjs');
const outputPath = resolve(repoRoot, 'plans', 'runtime-surface-report.md');

const packages = [
  { name: 'minimal', dir: resolve(repoRoot, 'dist', 'minimal'), hasTransform: false, hasRaster: false },
  { name: 'standard', dir: resolve(repoRoot, 'dist', 'standard'), hasTransform: true, hasRaster: false },
  { name: 'global', dir: resolve(repoRoot, 'dist', 'global'), hasTransform: true, hasRaster: false },
  { name: 'full', dir: resolve(repoRoot, 'dist', 'full'), hasTransform: true, hasRaster: true },
];

const aliasNotes = new Map([
  ['st_asewkt', 'local broad-doc extension shipped beyond the SedonaDB baseline'],
  ['st_aswkb', 'runtime alias of `ST_AsBinary`'],
  ['st_aswkt', 'runtime alias of `ST_AsText`'],
  ['st_expand', 'local broad-doc extension shipped beyond the SedonaDB baseline'],
  ['st_exteriorring', 'local broad-doc extension shipped beyond the SedonaDB baseline'],
  ['st_geogfromewkb', 'Phase 3 geography addition not yet represented as a local qmd page'],
  ['st_geogfromewkt', 'Phase 3 geography addition not yet represented as a local qmd page'],
  ['st_geogfromtext', 'runtime alias of `ST_GeogFromWKT`'],
  ['st_geogtogeometry', 'Phase 3 geography addition not yet represented as a local qmd page'],
  ['st_geometryfromtext', 'runtime compatibility alias for text geometry parsing'],
  ['st_geomfromgeojson', 'local broad-doc extension shipped beyond the SedonaDB baseline'],
  ['st_geomfromtext', 'runtime compatibility alias for text geometry parsing'],
  ['st_geomfromwkbunchecked', 'runtime unsafe parsing helper not yet represented as a local qmd page'],
  ['st_geomtogeography', 'Phase 3 geography addition not yet represented as a local qmd page'],
  ['st_makeenvelope', 'local broad-doc extension shipped beyond the SedonaDB baseline'],
  ['st_nrings', 'GEOS helper exposed at runtime without a standalone local qmd page'],
  ['st_numinteriorrings', 'GEOS helper exposed at runtime without a standalone local qmd page'],
  ['st_numpoints', 'GEOS helper exposed at runtime without a standalone local qmd page'],
]);

function loadDocsCatalog() {
  const names = readdirSync(docsDir)
    .filter((entry) => entry.endsWith('.qmd'))
    .map((entry) => basename(entry, '.qmd'))
    .sort();

  return {
    all: names,
    spatial: names.filter((name) => name.startsWith('st_') || name.startsWith('rs_')),
    st: names.filter((name) => name.startsWith('st_')),
    rs: names.filter((name) => name.startsWith('rs_')),
  };
}

function loadRuntimeCatalog(packageDir) {
  const output = execFileSync(process.execPath, [queryScript, packageDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const payload = JSON.parse(output);
  if (!payload.ok) {
    throw new Error(`Failed to query ${packageDir}: ${payload.error?.message ?? 'unknown error'}`);
  }
  return payload.routines;
}

function difference(left, rightSet) {
  return left.filter((item) => !rightSet.has(item));
}

function classifyDocOnly(name, pkg) {
  if (name === 'st_transform' && !pkg.hasTransform) {
    return 'omitted in this package because PROJ is not enabled';
  }
  if (name.startsWith('rs_') && !pkg.hasRaster) {
    return 'omitted in this package because raster/GDAL is not enabled';
  }
  return 'not exposed by the current runtime';
}

function formatList(items, fallback = 'none') {
  if (items.length === 0) {
    return fallback;
  }

  return items.map((item) => `- \`${item}\``).join('\n');
}

function formatRuntimeOnly(items) {
  if (items.length === 0) {
    return 'none';
  }

  return items
    .map((item) => `- \`${item}\`${aliasNotes.has(item) ? `: ${aliasNotes.get(item)}` : ''}`)
    .join('\n');
}

const docsCatalog = loadDocsCatalog();
const docsSet = new Set(docsCatalog.spatial);

const reportRows = packages.map((pkg) => {
  const routines = loadRuntimeCatalog(pkg.dir).sort();
  const routineSet = new Set(routines);
  const runtimeSt = routines.filter((name) => name.startsWith('st_'));
  const runtimeRs = routines.filter((name) => name.startsWith('rs_'));
  const runtimeOnly = difference(routines, docsSet);
  const docOnly = difference(docsCatalog.spatial, routineSet);

  return {
    ...pkg,
    routines,
    runtimeSt,
    runtimeRs,
    runtimeOnly,
    docOnly,
    docOnlyWithReasons: docOnly.map((name) => ({
      name,
      reason: classifyDocOnly(name, pkg),
    })),
  };
});

const commonRuntimeOnly = reportRows
  .map((row) => new Set(row.runtimeOnly))
  .reduce((common, current) => {
    if (common === null) {
      return current;
    }

    return new Set([...common].filter((item) => current.has(item)));
  }, null);

const markdown = `# Runtime Surface Report

Generated: ${new Date().toISOString()}

This report is generated from the built browser packages under \`dist/\` and the
local SedonaDB/Rust docs catalog under \`deps/sedona-db/docs/reference/sql\`.
Regenerate it with \`make surface-report\`.

## Local Docs Snapshot

- Local \`ST_*\` qmd pages: ${docsCatalog.st.length}
- Local \`RS_*\` qmd pages: ${docsCatalog.rs.length}
- Local spatial qmd pages considered here: ${docsCatalog.spatial.length}

## Package Summary

| Package | Runtime \`ST_*\` | Runtime \`RS_*\` | Runtime-only names | Docs-only names |
|---|---:|---:|---:|---:|
${reportRows
  .map(
    (row) =>
      `| \`${row.name}\` | ${row.runtimeSt.length} | ${row.runtimeRs.length} | ${row.runtimeOnly.length} | ${row.docOnly.length} |`,
  )
  .join('\n')}

## Common Runtime-only Names

These names are exposed at runtime but do not have standalone local qmd pages.
They include compatibility aliases and patch-added functions.

${formatRuntimeOnly([...commonRuntimeOnly].sort())}

${reportRows
  .map((row) => {
    const docOnlyLines =
      row.docOnlyWithReasons.length === 0
        ? 'none'
        : row.docOnlyWithReasons
            .map((entry) => `- \`${entry.name}\`: ${entry.reason}`)
            .join('\n');

    return `## Package: \`${row.name}\`

- Runtime \`ST_*\` names: ${row.runtimeSt.length}
- Runtime \`RS_*\` names: ${row.runtimeRs.length}

### Runtime-only Names

${formatRuntimeOnly(row.runtimeOnly)}

### Local-doc Names Not Exposed by This Package

${docOnlyLines}

### Full Runtime Catalog

${formatList(row.routines)}
`;
  })
  .join('\n')}
`;

writeFileSync(outputPath, markdown);
process.stdout.write(`${outputPath}\n`);
