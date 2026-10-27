import { CliError, EXIT_SOURCE_UNAVAILABLE } from '../errors.js';
import { invokeOrcaReadOnly } from './adapter.js';
import {
  RUN_LIST_MAX_IDS,
  RUN_LIST_MAX_PAGES,
  RUN_LIST_PAGE_LIMIT,
  WORKER_LIST_MAX_PAGES_PER_RUN,
  WORKER_LIST_PAGE_LIMIT,
  parseRunListJson,
  pinnedCollectRunId,
} from './runs.js';
import { parseWorkerListPage, type OrcaSupervisedRecord } from './workers.js';

function runtimeError(message: string): CliError {
  return new CliError({
    code: 'orca_runtime_unavailable',
    message,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

async function fetchRunListPage(cursor: string | null): Promise<{
  runIds: string[];
  nextCursor: string | null;
}> {
  const argv = [
    'orchestration',
    'run-list',
    '--json',
    '--limit',
    String(RUN_LIST_PAGE_LIMIT),
  ];
  if (cursor) {
    argv.push('--cursor', cursor);
  }
  const result = await invokeOrcaReadOnly(argv);
  if (result.exitCode !== 0) {
    throw runtimeError('Orca run-list failed.');
  }
  return parseRunListJson(result.stdout);
}

export async function listCollectRunIds(): Promise<string[]> {
  const pinned = pinnedCollectRunId();
  if (pinned) {
    return [pinned];
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let previousCursor: string | null = null;

  for (let page = 0; page < RUN_LIST_MAX_PAGES; page += 1) {
    const parsed = await fetchRunListPage(cursor);
    for (const id of parsed.runIds) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
      if (ids.length >= RUN_LIST_MAX_IDS) {
        return ids;
      }
    }
    if (!parsed.nextCursor || parsed.runIds.length === 0) {
      break;
    }
    if (parsed.nextCursor === previousCursor) {
      break;
    }
    previousCursor = parsed.nextCursor;
    cursor = parsed.nextCursor;
  }

  if (ids.length === 0) {
    throw runtimeError('Orca run-list returned no runs.');
  }
  return ids;
}

async function collectWorkersForRun(runId: string): Promise<OrcaSupervisedRecord[]> {
  const out: OrcaSupervisedRecord[] = [];
  let cursor: string | null = null;
  let previousCursor: string | null = null;

  for (let page = 0; page < WORKER_LIST_MAX_PAGES_PER_RUN; page += 1) {
    const argv = [
      'orchestration',
      'worker-list',
      '--json',
      '--run',
      runId,
      '--limit',
      String(WORKER_LIST_PAGE_LIMIT),
    ];
    if (cursor) {
      argv.push('--cursor', cursor);
    }
    const result = await invokeOrcaReadOnly(argv);
    if (result.exitCode !== 0) {
      throw runtimeError('Orca worker-list failed.');
    }
    const parsed = parseWorkerListPage(result.stdout);
    out.push(...parsed.records);
    if (!parsed.nextCursor || parsed.records.length === 0) {
      break;
    }
    if (parsed.nextCursor === previousCursor) {
      break;
    }
    previousCursor = parsed.nextCursor;
    cursor = parsed.nextCursor;
  }
  return out;
}

/**
 * Read-only worker rows for pinned run or every run-list id (bounded pages, no retries).
 */
export async function collectSupervisedRecords(): Promise<OrcaSupervisedRecord[]> {
  const runIds = await listCollectRunIds();
  const pinned = pinnedCollectRunId();
  const merged: OrcaSupervisedRecord[] = [];
  let workerListFailures = 0;

  for (const runId of runIds) {
    try {
      const rows = await collectWorkersForRun(runId);
      merged.push(...rows);
    } catch (err) {
      if (pinned) {
        throw err;
      }
      workerListFailures += 1;
    }
  }

  if (merged.length === 0 && workerListFailures === runIds.length) {
    throw runtimeError('Orca worker-list failed.');
  }
  return merged;
}
