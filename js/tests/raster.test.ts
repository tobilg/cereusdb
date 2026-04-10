import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildRasterFunctionCases,
  type RasterFunctionCase,
} from './support/raster-function-cases';
import { targetPackage } from './support/package';
import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';
import {
  listRuntimeFunctionsIsolated,
  runQuery,
  type QueryExecutionResult,
} from './support/wasm-testkit';

const runtimeRasterFunctions = listRuntimeFunctionsIsolated('rs_');
const rasterFunctionCases = buildRasterFunctionCases(runtimeRasterFunctions);

function assertRasterQueryCase(
  caseDefinition: RasterFunctionCase,
  result: QueryExecutionResult,
): void {
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
  }
}

describe('TypeScript WASM raster support', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  it('runs the GDAL-enabled package tier', () => {
    expect(targetPackage).toBe('full');
  });

  it('registers the full runtime RS_* catalog', async () => {
    const rows = await ctx.db.sqlJSON(
      "SELECT routine_name FROM information_schema.routines WHERE LEFT(routine_name, 3) = 'rs_' ORDER BY routine_name",
    );

    expect(rows.map((row) => String(row.routine_name))).toEqual(runtimeRasterFunctions);
  });

  it('defines a case for every registered RS_* routine', () => {
    expect([...new Set(rasterFunctionCases.map((entry) => entry.name))]).toEqual(
      runtimeRasterFunctions,
    );
  });

  it('registers GeoTIFF buffers through registerGeoTIFF()', async () => {
    const tableName = 'geotiff_buffer_fixture_full';
    ctx.db.registerGeoTIFF(tableName, ctx.geotiffBytes);

    const rows = await ctx.db.sqlJSON(`
      SELECT
        RS_Width(raster) AS width,
        RS_Height(raster) AS height,
        RS_NumBands(raster) AS band_count,
        RS_BandPixelType(raster, 1) AS pixel_type
      FROM ${tableName}
    `);

    expect(rows).toEqual([
      {
        width: 10,
        height: 10,
        band_count: 1,
        pixel_type: 'UNSIGNED_8BITS',
      },
    ]);
  });

  it('registers GeoTIFF buffers through registerRaster()', async () => {
    const tableName = 'geotiff_generic_fixture_full';
    ctx.db.registerRaster(tableName, ctx.geotiffBytes, 'geotiff');

    const rows = await ctx.db.sqlJSON(`
      SELECT
        RS_Width(raster) AS width,
        RS_Height(raster) AS height,
        RS_NumBands(raster) AS band_count
      FROM ${tableName}
    `);

    expect(rows).toEqual([
      {
        width: 10,
        height: 10,
        band_count: 1,
      },
    ]);
  });

  it('registers GeoTIFF files through registerFile()', async () => {
    const tableName = 'geotiff_file_fixture_full';
    const file = new File([ctx.geotiffBytes], 'fixture.tiff', { type: 'image/tiff' });

    await ctx.db.registerFile(tableName, file);

    const rows = await ctx.db.sqlJSON(`
      SELECT
        RS_Width(raster) AS width,
        RS_Height(raster) AS height,
        RS_NumBands(raster) AS band_count
      FROM ${tableName}
    `);

    expect(rows).toEqual([
      {
        width: 10,
        height: 10,
        band_count: 1,
      },
    ]);
  });

  it('evaluates raster spatial predicates on registered rasters', async () => {
    const tableName = 'geotiff_predicate_fixture_full';
    ctx.db.registerGeoTIFF(tableName, ctx.geotiffBytes);

    const rows = await ctx.db.sqlJSON(`
      SELECT
        RS_Contains(raster, raster) AS contains_self,
        RS_Intersects(raster, raster) AS intersects_self,
        RS_Within(raster, raster) AS within_self
      FROM ${tableName}
    `);

    expect(rows).toEqual([
      {
        contains_self: true,
        intersects_self: true,
        within_self: true,
      },
    ]);
  });

  for (const caseDefinition of rasterFunctionCases) {
    it(`covers ${caseDefinition.name}`, async () => {
      const result = await runQuery(ctx.db, caseDefinition.query);
      assertRasterQueryCase(caseDefinition, result);
    });
  }
});
