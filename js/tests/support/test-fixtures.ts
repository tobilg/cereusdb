import { readFile } from 'node:fs/promises';

import { CereusDB } from '../../src/index';
import { SAMPLE_GEOTIFF_PATH, SAMPLE_PARQUET_PATH, WASM_PATH } from './paths';

export interface TestContext {
  db: CereusDB;
  wasmBytes: Uint8Array;
  parquetBytes: Uint8Array;
  geotiffBytes: Uint8Array;
  remoteParquetDataUrl: string;
}

export async function createTestContext(): Promise<TestContext> {
  const wasmBytes = await readFile(WASM_PATH);
  const parquetBytes = await readFile(SAMPLE_PARQUET_PATH);
  const geotiffBytes = await readFile(SAMPLE_GEOTIFF_PATH);
  const remoteParquetDataUrl = `data:application/octet-stream;base64,${parquetBytes.toString('base64')}`;
  const db = await CereusDB.create({
    wasmSource: wasmBytes,
  });

  return {
    db,
    wasmBytes,
    parquetBytes,
    geotiffBytes,
    remoteParquetDataUrl,
  };
}
