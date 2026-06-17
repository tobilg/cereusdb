import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureRequest {
  method: string;
  url: string;
  range?: string;
}

export interface HttpRangeFixtureServer {
  origin: string;
  fileUrl: string;
  requests: FixtureRequest[];
  close(): Promise<void>;
}

const FIXTURE_PATH = '/fixtures/cities.parquet';
const LAST_MODIFIED = 'Tue, 16 Jun 2026 00:00:00 GMT';

interface ByteRange {
  start: number;
  endInclusive: number;
}

export async function startHttpRangeFixtureServer(
  bytes: Uint8Array,
): Promise<HttpRangeFixtureServer> {
  const requests: FixtureRequest[] = [];
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const range = req.headers.range;
    requests.push({
      method,
      url: req.url ?? '/',
      range: Array.isArray(range) ? range.join(', ') : range,
    });

    if (method === 'OPTIONS') {
      writeCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== FIXTURE_PATH) {
      writeCorsHeaders(res);
      res.writeHead(404);
      res.end();
      return;
    }

    if (method === 'HEAD') {
      writeObjectHeaders(res, bytes.byteLength);
      res.writeHead(200);
      res.end();
      return;
    }

    if (method !== 'GET') {
      writeCorsHeaders(res);
      res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' });
      res.end();
      return;
    }

    if (typeof range === 'string') {
      const parsed = parseByteRange(range, bytes.byteLength);
      if (parsed === undefined) {
        writeCorsHeaders(res);
        res.writeHead(416, { 'Content-Range': `bytes */${bytes.byteLength}` });
        res.end();
        return;
      }

      const body = bytes.subarray(parsed.start, parsed.endInclusive + 1);
      writeObjectHeaders(res, bytes.byteLength, parsed);
      res.writeHead(206);
      res.end(body);
      return;
    }

    writeObjectHeaders(res, bytes.byteLength);
    res.writeHead(200);
    res.end(bytes);
  });

  await listen(server);
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    fileUrl: `${origin}${FIXTURE_PATH}`,
    requests,
    close: () => close(server),
  };
}

function writeCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', [
    'Accept-Ranges',
    'Content-Length',
    'Content-Range',
    'ETag',
    'Last-Modified',
  ].join(', '));
}

function writeObjectHeaders(
  res: ServerResponse,
  objectSize: number,
  range?: ByteRange,
): void {
  writeCorsHeaders(res);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('ETag', '"cereusdb-test-parquet"');
  res.setHeader('Last-Modified', LAST_MODIFIED);
  if (range === undefined) {
    res.setHeader('Content-Length', objectSize);
    return;
  }

  res.setHeader('Content-Length', range.endInclusive - range.start + 1);
  res.setHeader(
    'Content-Range',
    `bytes ${range.start}-${range.endInclusive}/${objectSize}`,
  );
}

function parseByteRange(header: string, objectSize: number): ByteRange | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return undefined;
  }

  const [, startText, endText] = match;
  if (startText === '' && endText === '') {
    return undefined;
  }

  if (startText === '') {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return undefined;
    }
    const start = Math.max(objectSize - suffixLength, 0);
    return { start, endInclusive: objectSize - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText === '' ? objectSize - 1 : Number(endText);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= objectSize
  ) {
    return undefined;
  }

  return {
    start,
    endInclusive: Math.min(requestedEnd, objectSize - 1),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
