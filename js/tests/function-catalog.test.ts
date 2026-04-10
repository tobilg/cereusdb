import { beforeAll, describe, expect, it } from 'vitest';

import { buildGeoFunctionCases, type GeoFunctionCase } from './support/geo-function-cases';
import { packageExpectations, targetPackage } from './support/package';
import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';
import {
  listRuntimeFunctionsIsolated,
  runIsolatedQuery,
  runQuery,
  type QueryExecutionResult,
} from './support/wasm-testkit';

const runtimeFunctions = listRuntimeFunctionsIsolated();
const geoFunctionCases = buildGeoFunctionCases(runtimeFunctions);
const hasTransform = runtimeFunctions.includes('st_transform');

function assertQueryCase(caseDefinition: GeoFunctionCase, result: QueryExecutionResult): void {
  const detail = `${caseDefinition.name} (${caseDefinition.source})`;

  switch (caseDefinition.expectation.kind) {
    case 'non-empty-result':
      expect(result.ok, detail).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.data.length, detail).toBeGreaterThan(0);
      return;
    case 'field-equals':
      expect(result.ok, detail).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.[caseDefinition.expectation.field], detail).toEqual(
        caseDefinition.expectation.value,
      );
      return;
    case 'field-includes':
      expect(result.ok, detail).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.data).toHaveLength(1);
      expect(String(result.data[0]?.[caseDefinition.expectation.field]), detail).toContain(
        caseDefinition.expectation.value,
      );
      return;
    case 'error-includes':
      expect(result.ok, detail).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.message, detail).toContain(caseDefinition.expectation.value);
      return;
  }
}

describe('TypeScript WASM function catalog', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  it('matches the expected package feature surface', async () => {
    const rasterFunctions = (await ctx.db.sqlJSON(
      "SELECT routine_name FROM information_schema.routines WHERE LEFT(routine_name, 3) = 'rs_' ORDER BY routine_name",
    )).map((row) => String(row.routine_name));

    expect(runtimeFunctions.includes('st_knn')).toBe(packageExpectations[targetPackage].hasKnn);
    expect(runtimeFunctions).toContain('st_contains');
    expect(hasTransform).toBe(packageExpectations[targetPackage].hasTransform);
    expect(rasterFunctions.length > 0).toBe(packageExpectations[targetPackage].hasRaster);
  });

  it('defines a case for every registered ST_* routine', () => {
    expect([...new Set(geoFunctionCases.map((entry) => entry.name))]).toEqual(runtimeFunctions);
  });

  for (const caseDefinition of geoFunctionCases) {
    it(`covers ${caseDefinition.name}`, async () => {
      const result =
        caseDefinition.execution === 'isolated'
          ? runIsolatedQuery(caseDefinition.query)
          : await runQuery(ctx.db, caseDefinition.query);

      assertQueryCase(caseDefinition, result);
    });
  }
});
