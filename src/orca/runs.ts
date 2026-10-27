import { CliError, EXIT_SOURCE_UNAVAILABLE } from '../errors.js';

export const RUN_LIST_PAGE_LIMIT = 20;
export const RUN_LIST_MAX_PAGES = 5;
export const RUN_LIST_MAX_IDS = 40;
export const WORKER_LIST_PAGE_LIMIT = 100;
export const WORKER_LIST_MAX_PAGES_PER_RUN = 3;

export type OrcaRunListPage = {
  runIds: string[];
  nextCursor: string | null;
};

function schemaError(path: string, detail: string): CliError {
  return new CliError({
    code: 'orca_schema_drift',
    message: `Orca run-list JSON invalid at ${path}: ${detail}`,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

function asCursor(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

/**
 * Parse `orca orchestration run-list --json`.
 * Live envelope (1.4.241): `result.runs[].id`, `result.nextCursor`.
 */
export function parseRunListJson(text: string): OrcaRunListPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw schemaError('root', 'invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw schemaError('root', 'expected object');
  }
  const root = parsed as Record<string, unknown>;
  if (root['ok'] === false) {
    throw new CliError({
      code: 'orca_runtime_unavailable',
      message: 'Orca run-list returned ok=false.',
      exitCode: EXIT_SOURCE_UNAVAILABLE,
    });
  }
  const result = root['result'];
  if (!result || typeof result !== 'object') {
    throw schemaError('result', 'missing result');
  }
  const rec = result as Record<string, unknown>;
  const runs = rec['runs'];
  if (!Array.isArray(runs)) {
    throw schemaError('result.runs', 'expected array');
  }
  const runIds: string[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const row = runs[i];
    if (!row || typeof row !== 'object') {
      continue;
    }
    const id = (row as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) {
      runIds.push(id);
    }
  }
  return {
    runIds,
    nextCursor: asCursor(rec['nextCursor']),
  };
}

export function pinnedCollectRunId(): string | undefined {
  const telemetry = process.env['ORCA_TELEMETRY_COLLECT_RUN']?.trim();
  if (telemetry) {
    return telemetry;
  }
  const alias = process.env['ORCA_COLLECT_RUN_ID']?.trim();
  if (alias) {
    return alias;
  }
  return undefined;
}
