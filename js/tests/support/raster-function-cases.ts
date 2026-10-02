import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DOCS_SQL_DIR } from './paths';

export type RasterFunctionExpectation =
  | { kind: 'non-empty-result' }
  | { kind: 'field-equals'; field: string; value: unknown }
  | { kind: 'field-includes'; field: string; value: string };

export interface RasterFunctionCase {
  name: string;
  query: string;
  source: 'docs' | 'manual';
  expectation: RasterFunctionExpectation;
  reference?: string;
}

// A reference raster without skew; RS_AsRaster rejects skewed references.
const UNSKEWED_RASTER = "RS_SetGeoReference(RS_Example(), '1 0 0 -1 0 32')";
const CLIP_POLYGON = "ST_GeomFromText('POLYGON ((60 90, 160 90, 160 190, 60 190, 60 90))', 'OGC:CRS84')";

const MANUAL_CASES: Record<string, RasterFunctionCase> = {
  // GDAL-backed functions from sedona-raster-gdal. RS_FromPath is not exposed
  // in the browser build, so these cases start from in-memory rasters.
  rs_asraster: {
    name: 'rs_asraster',
    query: `SELECT RS_Width(RS_AsRaster(ST_GeomFromText('POLYGON ((2 2, 8 2, 8 8, 2 8, 2 2))', 'OGC:CRS84'), ${UNSKEWED_RASTER}, 'b', true, 1)) AS value`,
    source: 'manual',
    expectation: { kind: 'field-equals', field: 'value', value: 6 },
  },
  rs_clip: {
    name: 'rs_clip',
    query: `SELECT RS_Width(RS_Clip(RS_Example(), 1, ${CLIP_POLYGON})) AS value`,
    source: 'manual',
    expectation: { kind: 'field-equals', field: 'value', value: 64 },
  },
  rs_fromgdalraster: {
    name: 'rs_fromgdalraster',
    query: 'SELECT RS_Width(RS_FromGDALRaster(RS_AsGeoTiff(RS_Example()))) AS value',
    source: 'manual',
    expectation: { kind: 'field-equals', field: 'value', value: 64 },
  },
  rs_reprojectmatch: {
    name: 'rs_reprojectmatch',
    query: 'SELECT RS_Width(RS_ReprojectMatch(RS_Example(), RS_Example())) AS value',
    source: 'manual',
    expectation: { kind: 'field-equals', field: 'value', value: 64 },
  },
  rs_resample: {
    name: 'rs_resample',
    query: "SELECT RS_Width(RS_Resample(RS_Example(), 32, 16, false, 'NearestNeighbor')) AS value",
    source: 'manual',
    expectation: { kind: 'field-equals', field: 'value', value: 32 },
  },
  rs_tile: {
    name: 'rs_tile',
    query: 'SELECT COUNT(*) AS value FROM (SELECT UNNEST(RS_Tile(RS_Example(), 32, 16)) AS tile)',
    source: 'manual',
    expectation: { kind: 'field-equals', field: 'value', value: 4 },
  },
  rs_zonalstats: {
    name: 'rs_zonalstats',
    query: `SELECT RS_ZonalStats(RS_Example(), ${CLIP_POLYGON}, 1, 'mean') AS value`,
    source: 'manual',
    expectation: { kind: 'field-equals', field: 'value', value: 1 },
  },
  rs_example: {
    name: 'rs_example',
    query: 'SELECT RS_Width(RS_Example()) AS value',
    source: 'manual',
    expectation: { kind: 'field-equals', field: 'value', value: 64 },
  },
};

function extractFirstSqlBlock(markdown: string, filePath: string): string {
  const match = markdown.match(/```sql\s*([\s\S]*?)```/i);
  if (!match) {
    throw new Error(`No SQL example found in ${filePath}`);
  }

  return match[1].trim();
}

export function buildRasterFunctionCases(runtimeFunctions: string[]): RasterFunctionCase[] {
  const missingFunctions: string[] = [];

  const cases = runtimeFunctions
    .slice()
    .sort()
    .map((functionName) => {
      const manualCase = MANUAL_CASES[functionName];
      if (manualCase) {
        return manualCase;
      }

      const docPath = resolve(DOCS_SQL_DIR, `${functionName}.qmd`);
      if (!existsSync(docPath)) {
        missingFunctions.push(functionName);
        return null;
      }

      const query = extractFirstSqlBlock(readFileSync(docPath, 'utf8'), docPath);
      return {
        name: functionName,
        query,
        source: 'docs' as const,
        expectation: { kind: 'non-empty-result' as const },
        reference: docPath,
      };
    })
    .filter((value): value is RasterFunctionCase => value !== null);

  if (missingFunctions.length > 0) {
    throw new Error(`Missing raster-function test cases for: ${missingFunctions.join(', ')}`);
  }

  return cases;
}
