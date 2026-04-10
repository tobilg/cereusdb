import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DOCS_SQL_DIR } from './paths';

export type GeoFunctionExpectation =
  | { kind: 'non-empty-result' }
  | { kind: 'field-equals'; field: string; value: unknown }
  | { kind: 'field-includes'; field: string; value: string }
  | { kind: 'error-includes'; value: string };

export interface GeoFunctionCase {
  name: string;
  query: string;
  source: 'docs' | 'manual';
  execution: 'in-process' | 'isolated';
  expectation: GeoFunctionExpectation;
  reference?: string;
}

const MANUAL_CASES: Record<string, GeoFunctionCase> = {
  st_aswkb: {
    name: 'st_aswkb',
    query: 'SELECT ST_AsWKB(ST_Point(1, 2)) AS value',
    source: 'manual',
    execution: 'in-process',
    expectation: {
      kind: 'field-equals',
      field: 'value',
      value: '0101000000000000000000f03f0000000000000040',
    },
  },
  st_aswkt: {
    name: 'st_aswkt',
    query: 'SELECT ST_AsWKT(ST_Point(1, 2)) AS value',
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'POINT(1 2)' },
  },
  st_asewkt: {
    name: 'st_asewkt',
    query: "SELECT ST_AsEWKT(ST_SetSRID(ST_Point(1, 2), 3857)) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'SRID=3857;POINT(1 2)' },
  },
  st_closestpoint: {
    name: 'st_closestpoint',
    query: "SELECT ST_AsText(ST_ClosestPoint(ST_GeomFromText('LINESTRING(0 0, 4 0)'), ST_GeomFromText('POINT(2 3)'))) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'POINT(2 0)' },
  },
  st_geogfromtext: {
    name: 'st_geogfromtext',
    query: "SELECT ST_AsText(ST_GeogFromText('POINT (1 2)')) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'POINT(1 2)' },
  },
  st_geogfromewkb: {
    name: 'st_geogfromewkb',
    query: "SELECT ST_CRS(ST_GeogFromEWKB(ST_AsEWKB(ST_SetSRID(ST_Point(1, 2), 3857)))) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'EPSG:3857' },
  },
  st_geogfromewkt: {
    name: 'st_geogfromewkt',
    query: "SELECT ST_CRS(ST_GeogFromEWKT('SRID=3857;POINT(1 2)')) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'EPSG:3857' },
  },
  st_geogtogeometry: {
    name: 'st_geogtogeometry',
    query: "SELECT ST_CRS(ST_GeogToGeometry(ST_GeogFromEWKT('SRID=3857;POINT(1 2)'))) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'EPSG:3857' },
  },
  st_geometryfromtext: {
    name: 'st_geometryfromtext',
    query: "SELECT ST_AsText(ST_GeometryFromText('POINT (1 2)')) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'POINT(1 2)' },
  },
  st_geomfromtext: {
    name: 'st_geomfromtext',
    query: "SELECT ST_AsText(ST_GeomFromText('POINT (1 2)')) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'POINT(1 2)' },
  },
  st_geomtogeography: {
    name: 'st_geomtogeography',
    query: "SELECT ST_CRS(ST_GeomToGeography(ST_GeomFromEWKT('SRID=3857;POINT(1 2)'))) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'EPSG:3857' },
  },
  st_geomfromwkbunchecked: {
    name: 'st_geomfromwkbunchecked',
    query: 'SELECT ST_AsText(ST_GeomFromWKBUnchecked(ST_AsWKB(ST_Point(1, 2)))) AS value',
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'POINT(1 2)' },
  },
  st_geomfromgeojson: {
    name: 'st_geomfromgeojson',
    query: `SELECT ST_AsText(ST_GeomFromGeoJSON('{"type":"Feature","properties":{"id":1},"geometry":{"type":"Point","coordinates":[1,2]}}')) AS value`,
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 'POINT(1 2)' },
  },
  st_expand: {
    name: 'st_expand',
    query: "SELECT ST_AsText(ST_Expand(ST_GeomFromText('POINT Z (0 0 5)'), 1, 2, 3)) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-includes', field: 'value', value: '1 2 8' },
  },
  st_exteriorring: {
    name: 'st_exteriorring',
    query: "SELECT ST_AsText(ST_ExteriorRing(ST_GeomFromText('POLYGON((0 0,3 0,3 3,0 3,0 0))'))) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: {
      kind: 'field-equals',
      field: 'value',
      value: 'LINESTRING(0 0,3 0,3 3,0 3,0 0)',
    },
  },
  st_knn: {
    name: 'st_knn',
    query: 'SELECT ST_KNN(ST_Point(0, 0), ST_Point(1, 1), 1, false) AS value',
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'error-includes', value: 'outside a spatial join' },
  },
  st_linelocatepoint: {
    name: 'st_linelocatepoint',
    query: "SELECT ST_LineLocatePoint(ST_GeomFromText('LINESTRING(0 0, 4 0)'), ST_GeomFromText('POINT(2 3)')) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 0.5 },
  },
  st_maxdistance: {
    name: 'st_maxdistance',
    query: "SELECT ROUND(ST_MaxDistance(ST_GeomFromText('POLYGON((10 10, 11 10, 10 11, 10 10))'), ST_GeomFromText('POLYGON((0 0, 1 0, 0 1, 0 0))')), 6) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 14.866069 },
  },
  st_makeenvelope: {
    name: 'st_makeenvelope',
    query: 'SELECT ST_AsText(ST_MakeEnvelope(0, 1, 2, 3)) AS value',
    source: 'manual',
    execution: 'in-process',
    expectation: {
      kind: 'field-equals',
      field: 'value',
      value: 'POLYGON((0 1,2 1,2 3,0 3,0 1))',
    },
  },
  st_shortestline: {
    name: 'st_shortestline',
    query: "SELECT ST_AsText(ST_ShortestLine(ST_GeogFromWKT('POINT(0 0)'), ST_GeogFromWKT('POINT(3 4)'))) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: {
      kind: 'field-includes',
      field: 'value',
      value: 'LINESTRING(0 0,3',
    },
  },
  st_nrings: {
    name: 'st_nrings',
    query: "SELECT ST_NRings(ST_GeomFromText('POLYGON((0 0, 6 0, 6 6, 0 6, 0 0), (2 2, 4 2, 4 4, 2 4, 2 2))')) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 2 },
  },
  st_numinteriorrings: {
    name: 'st_numinteriorrings',
    query: "SELECT ST_NumInteriorRings(ST_GeomFromText('POLYGON((0 0, 6 0, 6 6, 0 6, 0 0), (2 2, 4 2, 4 4, 2 4, 2 2))')) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 1 },
  },
  st_numpoints: {
    name: 'st_numpoints',
    query: "SELECT ST_NumPoints(ST_GeomFromText('LINESTRING(0 0, 1 1, 2 1, 3 2)')) AS value",
    source: 'manual',
    execution: 'in-process',
    expectation: { kind: 'field-equals', field: 'value', value: 4 },
  },
  st_transform: {
    name: 'st_transform',
    query: "SELECT ST_AsText(ST_Transform(ST_SetCRS(ST_Point(1, 1), 'EPSG:4326'), 'EPSG:3857')) AS value",
    source: 'manual',
    execution: 'isolated',
    expectation: {
      kind: 'field-equals',
      field: 'value',
      value: 'POINT(111319.49079327357 111325.1428663851)',
    },
  },
};

function extractFirstSqlBlock(markdown: string, filePath: string): string {
  const match = markdown.match(/```sql\s*([\s\S]*?)```/i);
  if (!match) {
    throw new Error(`No SQL example found in ${filePath}`);
  }

  return match[1].trim();
}

export function buildGeoFunctionCases(runtimeFunctions: string[]): GeoFunctionCase[] {
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
        execution: 'in-process' as const,
        expectation: { kind: 'non-empty-result' as const },
        reference: docPath,
      };
    })
    .filter((value): value is GeoFunctionCase => value !== null);

  if (missingFunctions.length > 0) {
    throw new Error(`Missing geo-function test cases for: ${missingFunctions.join(', ')}`);
  }

  return cases;
}
