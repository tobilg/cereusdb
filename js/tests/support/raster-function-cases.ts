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

const MANUAL_CASES: Record<string, RasterFunctionCase> = {
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
