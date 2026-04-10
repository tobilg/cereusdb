import { spawnSync } from 'node:child_process';

import type { CereusDB } from '../../src/index';
import { JS_DIR, RUNNER_PATH } from './paths';

export interface QueryFailure {
  ok: false;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface QuerySuccess {
  ok: true;
  data: Record<string, unknown>[];
}

export type QueryExecutionResult = QueryFailure | QuerySuccess;

interface FunctionListSuccess {
  ok: true;
  data: string[];
}

function normalizeError(error: unknown): QueryFailure {
  const value = error as { name?: string; message?: string; stack?: string } | undefined;
  return {
    ok: false,
    error: {
      name: value?.name ?? 'Error',
      message: value?.message ?? String(error),
      stack: value?.stack,
    },
  };
}

function spawnRunner(args: string[]) {
  return spawnSync(process.execPath, [RUNNER_PATH, ...args], {
    cwd: JS_DIR,
    encoding: 'utf8',
  });
}

export async function runQuery(db: CereusDB, query: string): Promise<QueryExecutionResult> {
  try {
    const data = await db.sqlJSON(query);
    return { ok: true, data };
  } catch (error) {
    return normalizeError(error);
  }
}

export function runIsolatedQuery(query: string): QueryExecutionResult {
  const child = spawnRunner(['query', query]);

  if (child.error) {
    return normalizeError(child.error);
  }

  const stdout = child.stdout.trim();
  if (child.status === 0 && stdout.length > 0) {
    try {
      return JSON.parse(stdout) as QueryExecutionResult;
    } catch {
      return {
        ok: false,
        error: {
          name: 'RunnerParseError',
          message: `Failed to parse runner output: ${stdout}`,
          stack: child.stderr.trim(),
        },
      };
    }
  }

  const stderr = child.stderr.trim();
  return {
    ok: false,
    error: {
      name: 'RunnerProcessError',
      message: stderr || stdout || `Runner exited with code ${child.status ?? 'unknown'}`,
      stack: stderr,
    },
  };
}

export function listRuntimeFunctionsIsolated(prefix = 'st_'): string[] {
  const child = spawnRunner(['list-functions', prefix]);

  if (child.error) {
    throw child.error;
  }

  if (child.status !== 0) {
    throw new Error(child.stderr.trim() || `Function catalog runner failed with code ${child.status}`);
  }

  const stdout = child.stdout.trim();
  if (stdout.length === 0) {
    throw new Error('Function catalog runner returned no output');
  }

  const parsed = JSON.parse(stdout) as FunctionListSuccess | QueryFailure;
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }

  return parsed.data;
}
