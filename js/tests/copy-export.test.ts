import { readFile } from 'node:fs/promises';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CereusDB,
  downloadFile,
  MemoryStorageBackend,
  PARQUET_MIME_TYPE,
  type ExportHandler,
} from '../src/index';
import { WASM_PATH } from './support/paths';

interface ExportedFile {
  filename: string;
  data: Uint8Array;
  mimeType: string;
}

let wasmBytes: Uint8Array;

beforeAll(async () => {
  wasmBytes = await readFile(WASM_PATH);
});

async function openWithExports(): Promise<{ db: CereusDB; files: ExportedFile[] }> {
  const files: ExportedFile[] = [];
  const onExport: ExportHandler = (filename, data, mimeType) => {
    files.push({ filename, data, mimeType });
  };
  const db = await CereusDB.create({
    wasmSource: wasmBytes,
    onExport,
    storage: { opfs: new MemoryStorageBackend() },
  });
  await db.sqlJSON(`
    CREATE TABLE places AS
    SELECT * FROM (VALUES
      (1, 'a', ST_Point(1, 2)),
      (2, 'b', ST_Point(3, 4)),
      (3, 'c', ST_Point(5, 6))
    ) AS t(id, name, geom)
  `);
  return { db, files };
}

function isParquet(data: Uint8Array): boolean {
  const text = new TextDecoder('latin1');
  return (
    text.decode(data.subarray(0, 4)) === 'PAR1' &&
    text.decode(data.subarray(data.length - 4)) === 'PAR1'
  );
}

describe('COPY ... TO', () => {
  it('exports a table to the export handler', async () => {
    const { db, files } = await openWithExports();
    await expect(db.sqlJSON(`COPY places TO 'places.parquet'`)).resolves.toEqual([{ count: 3 }]);

    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe('places.parquet');
    expect(files[0]?.mimeType).toBe(PARQUET_MIME_TYPE);
    expect(isParquet(files[0]!.data)).toBe(true);

    await db.registerFile('copied', new File([files[0]!.data as Uint8Array<ArrayBuffer>], 'x.parquet'));
    await expect(
      db.sqlJSON(`SELECT id, ST_AsText(geom) AS wkt FROM copied ORDER BY id`),
    ).resolves.toEqual([
      { id: 1, wkt: 'POINT(1 2)' },
      { id: 2, wkt: 'POINT(3 4)' },
      { id: 3, wkt: 'POINT(5 6)' },
    ]);
  });

  it('exports query results with format and options', async () => {
    const { db, files } = await openWithExports();
    await expect(
      db.sqlJSON(`
        COPY (SELECT id, geom FROM places WHERE id > 1) TO 'subset.out'
        STORED AS GEOPARQUET OPTIONS (compression 'snappy', row_group_size 1)
      `),
    ).resolves.toEqual([{ count: 2 }]);
    expect(files.map((file) => file.filename)).toEqual(['subset.out']);
    expect(isParquet(files[0]!.data)).toBe(true);

    await db.sqlJSON(`COPY places TO 'compat.parquet' STORED AS PARQUET OPTIONS ('format.compression' 'zstd')`);
    expect(files.map((file) => file.filename)).toEqual(['subset.out', 'compat.parquet']);
  });

  it('exports tables of persistent databases', async () => {
    const { db, files } = await openWithExports();
    await db.createDatabase('opfs://copydb');
    await db.sqlJSON(`CREATE TABLE copydb.public.points AS SELECT id, geom FROM places`);
    await db.detachDatabase('copydb');
    await db.attachDatabase('opfs://copydb');

    await expect(db.sqlJSON(`COPY copydb.public.points TO 'points.parquet'`)).resolves.toEqual([
      { count: 3 },
    ]);
    expect(files.map((file) => file.filename)).toEqual(['points.parquet']);
  });

  it('rejects unsupported targets, formats and options', async () => {
    const { db, files } = await openWithExports();
    await expect(db.sqlJSON(`COPY places TO 'places.csv' STORED AS CSV`)).rejects.toThrow(
      'Unsupported COPY format CSV',
    );
    await expect(db.sqlJSON(`COPY places TO 'places.txt'`)).rejects.toThrow(
      'Cannot infer the format',
    );
    await expect(db.sqlJSON(`COPY places TO 'opfs://exports/places.parquet'`)).rejects.toThrow(
      'use a file name',
    );
    await expect(
      db.sqlJSON(`COPY places TO 'places.parquet' PARTITIONED BY (name)`),
    ).rejects.toThrow('PARTITIONED BY is not supported');
    await expect(
      db.sqlJSON(`COPY places TO 'places.parquet' OPTIONS (bloom_filter 'true')`),
    ).rejects.toThrow("Unsupported COPY option 'bloom_filter'");
    await expect(
      db.sqlJSON(`COPY places TO 'places.parquet' OPTIONS (compression 'lzma')`),
    ).rejects.toThrow("Unsupported compression 'lzma'");
    expect(files).toEqual([]);
  });

  it('reports a missing or failing export handler', async () => {
    const withoutHandler = await CereusDB.create({ wasmSource: wasmBytes, onExport: false });
    await withoutHandler.sqlJSON(`CREATE TABLE t AS SELECT 1 AS id`);
    await expect(withoutHandler.sqlJSON(`COPY t TO 't.parquet'`)).rejects.toThrow(
      'no export handler',
    );
    await expect(withoutHandler.downloadGeoParquet('t')).rejects.toThrow('No export handler');

    const failing = await CereusDB.create({
      wasmSource: wasmBytes,
      onExport: async () => {
        throw new Error('disk full');
      },
    });
    await failing.sqlJSON(`CREATE TABLE t AS SELECT 1 AS id`);
    await expect(failing.sqlJSON(`COPY t TO 't.parquet'`)).rejects.toThrow('disk full');
  });
});

describe('downloadGeoParquet()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes the file to the export handler with a default name', async () => {
    const { db, files } = await openWithExports();
    await expect(db.downloadGeoParquet('places')).resolves.toBe('places.parquet');
    await expect(db.downloadGeoParquet('SELECT id FROM places')).resolves.toBe('export.parquet');
    await expect(
      db.downloadGeoParquet('places', { filename: 'custom.parquet', compression: 'snappy' }),
    ).resolves.toBe('custom.parquet');

    expect(files.map((file) => file.filename)).toEqual([
      'places.parquet',
      'export.parquet',
      'custom.parquet',
    ]);
    expect(files.every((file) => file.mimeType === PARQUET_MIME_TYPE && isParquet(file.data))).toBe(
      true,
    );
  });

  it('downloads through a link when a document is available', async () => {
    const link = {
      href: '',
      download: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    };
    const appendChild = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => link),
      body: { appendChild },
    });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    // Without onExport, CereusDB uses downloadFile() when a document exists.
    const db = await CereusDB.create({ wasmSource: wasmBytes });
    await db.sqlJSON(`CREATE TABLE t AS SELECT 1 AS id, ST_Point(0, 0) AS geom`);
    await expect(db.sqlJSON(`COPY t TO 'download.parquet'`)).resolves.toEqual([{ count: 1 }]);

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect((createObjectURL.mock.calls[0]?.[0] as Blob).type).toBe(PARQUET_MIME_TYPE);
    expect(link.href).toBe('blob:export');
    expect(link.download).toBe('download.parquet');
    expect(appendChild).toHaveBeenCalledWith(link);
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
  });

  it('requires a document for downloadFile()', () => {
    expect(() => downloadFile('x.parquet', new Uint8Array([1]))).toThrow(
      'needs a browser document',
    );
  });
});
