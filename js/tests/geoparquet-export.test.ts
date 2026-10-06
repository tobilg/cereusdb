import { beforeAll, describe, expect, it } from 'vitest';

import { packageExpectations, targetPackage } from './support/package';
import type { TestContext } from './support/test-fixtures';
import { createTestContext } from './support/test-fixtures';

const PARQUET_MAGIC = 'PAR1';

/** Extract the GeoParquet `geo` metadata JSON from a Parquet file's footer. */
function geoMetadata(bytes: Uint8Array): Record<string, any> | null {
  const text = new TextDecoder('latin1').decode(bytes);
  const start = text.lastIndexOf('{"columns":');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') depth -= 1;
    if (depth === 0) {
      return JSON.parse(text.slice(start, index + 1));
    }
  }
  throw new Error('unterminated geo metadata');
}

function parquetFile(bytes: Uint8Array, name: string): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], name);
}

describe('GeoParquet export', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.db.sqlJSON(`
      CREATE TABLE export_places AS
      SELECT * FROM (VALUES
        (1, 'a', ST_Point(1, 2)),
        (2, 'b', ST_Point(-3, 5)),
        (3, 'c', ST_GeomFromWKT('LINESTRING (0 0, 10 -1)'))
      ) AS t(id, name, geom)
    `);
  });

  it('writes geo metadata and round-trips through registerFile', async () => {
    const bytes = await ctx.db.exportGeoParquet('export_places');
    const text = new TextDecoder('latin1');
    expect(text.decode(bytes.subarray(0, 4))).toBe(PARQUET_MAGIC);
    expect(text.decode(bytes.subarray(bytes.length - 4))).toBe(PARQUET_MAGIC);

    expect(geoMetadata(bytes)).toEqual({
      version: '1.1.0',
      primary_column: 'geom',
      columns: {
        geom: {
          encoding: 'WKB',
          geometry_types: [],
          crs: null,
          bbox: [-3, -1, 10, 5],
        },
      },
    });

    await ctx.db.registerFile('export_roundtrip', parquetFile(bytes, 'places.parquet'));
    await expect(
      ctx.db.sqlJSON(`SELECT id, name, ST_AsText(geom) AS wkt FROM export_roundtrip ORDER BY id`),
    ).resolves.toEqual([
      { id: 1, name: 'a', wkt: 'POINT(1 2)' },
      { id: 2, name: 'b', wkt: 'POINT(-3 5)' },
      { id: 3, name: 'c', wkt: 'LINESTRING(0 0,10 -1)' },
    ]);
  });

  it('exports query results and honors writer options', async () => {
    const bytes = await ctx.db.exportGeoParquet(
      'SELECT id, ST_SetSRID(geom, 4326) AS geometry, geom AS other FROM export_places WHERE id < 3',
      { compression: 'snappy', rowGroupSize: 1 },
    );
    const metadata = geoMetadata(bytes);
    expect(metadata?.primary_column).toBe('geometry');
    // OGC:CRS84 / EPSG:4326 is the GeoParquet default, so crs is omitted.
    expect(metadata?.columns.geometry).toEqual({
      encoding: 'WKB',
      geometry_types: [],
      bbox: [-3, 2, 1, 5],
    });
    expect(metadata?.columns.other.crs).toBeNull();

    await ctx.db.registerFile('export_query', parquetFile(bytes, 'query.parquet'));
    await expect(
      ctx.db.sqlJSON(`SELECT COUNT(*) AS n FROM export_query`),
    ).resolves.toEqual([{ n: 2 }]);
  });

  it('converts other CRS to PROJJSON when PROJ is available', async () => {
    const query = 'SELECT ST_SetSRID(geom, 3857) AS geom FROM export_places';
    if (packageExpectations[targetPackage].hasTransform) {
      const metadata = geoMetadata(await ctx.db.exportGeoParquet(query));
      expect(metadata?.columns.geom.crs).toMatchObject({
        type: 'ProjectedCRS',
        id: { authority: 'EPSG', code: 3857 },
      });
    } else {
      await expect(ctx.db.exportGeoParquet(query)).rejects.toThrow('requires a package with PROJ');
    }
  });

  it('marks geography columns as spherical', async () => {
    const metadata = geoMetadata(
      await ctx.db.exportGeoParquet('SELECT ST_GeogPoint(1, 2) AS place'),
    );
    expect(metadata?.columns.place).toMatchObject({ encoding: 'WKB', edges: 'spherical' });
    // Cartesian bounds do not apply to spherical edges.
    expect(metadata?.columns.place.bbox).toBeUndefined();
  });

  it('writes plain Parquet without geometry columns and validates input', async () => {
    const bytes = await ctx.db.exportGeoParquet('SELECT id, name FROM export_places');
    expect(geoMetadata(bytes)).toBeNull();

    await expect(
      ctx.db.exportGeoParquet('export_places', { compression: 'lzma' as never }),
    ).rejects.toThrow("Unsupported compression 'lzma'");
    await expect(ctx.db.exportGeoParquet('DROP TABLE export_places')).rejects.toThrow();
    await expect(ctx.db.sqlJSON('SELECT COUNT(*) AS n FROM export_places')).resolves.toEqual([
      { n: 3 },
    ]);
  });
});
