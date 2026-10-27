import { CliError, EXIT_SOURCE_UNAVAILABLE } from '../errors.js';

export type OrcaSupervisedRecord = {
  hostId: string;
  runId: string | null;
  taskId: string | null;
  dispatchId: string | null;
  worktreeId: string | null;
  agentTerminalHandle: string | null;
  providerSessionId: string | null;
  issueRefHint: string | null;
};

function schemaError(path: string, detail: string): CliError {
  return new CliError({
    code: 'orca_schema_drift',
    message: `Orca worker JSON invalid at ${path}: ${detail}`,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

function parseHostIdFromProjection(projection: Record<string, unknown>): string {
  const host = projection['host'];
  if (!host || typeof host !== 'object') {
    throw schemaError('projection.host', 'missing host object');
  }
  const id = (host as Record<string, unknown>)['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw schemaError('projection.host.id', 'expected non-empty string');
  }
  return id;
}

function parseHostScope(hostScope: unknown): string {
  if (typeof hostScope === 'string') {
    try {
      const parsed = JSON.parse(hostScope) as Record<string, unknown>;
      const hostId = parsed['hostId'];
      if (typeof hostId === 'string' && hostId.length > 0) {
        return hostId;
      }
    } catch {
      throw schemaError('dispatch.host_scope', 'invalid JSON string');
    }
  }
  if (hostScope && typeof hostScope === 'object') {
    const hostId = (hostScope as Record<string, unknown>)['hostId'];
    if (typeof hostId === 'string' && hostId.length > 0) {
      return hostId;
    }
  }
  throw schemaError('dispatch.host_scope', 'missing hostId');
}

function recordFromWorkerListRow(worker: Record<string, unknown>): OrcaSupervisedRecord {
  const dispatchId = asNullableString(worker['dispatchId']);
  const projection = worker['projection'];
  if (!projection || typeof projection !== 'object') {
    throw schemaError('workers[].projection', 'missing projection');
  }
  const hostId = parseHostIdFromProjection(projection as Record<string, unknown>);
  const resource = worker['resource'];
  let worktreeId: string | null = null;
  if (resource && typeof resource === 'object') {
    worktreeId = asNullableString((resource as Record<string, unknown>)['worktreeId']);
  }
  return {
    hostId,
    runId: asNullableString(worker['runId']),
    taskId: asNullableString(worker['taskId']),
    dispatchId,
    worktreeId,
    agentTerminalHandle: asNullableString(worker['agentTerminalHandle']),
    providerSessionId: null,
    issueRefHint: null,
  };
}

export type OrcaWorkerListPage = {
  records: OrcaSupervisedRecord[];
  nextCursor: string | null;
};

function workerListNextCursor(result: Record<string, unknown>): string | null {
  const page = result['page'];
  if (!page || typeof page !== 'object') {
    return null;
  }
  const cursor = (page as Record<string, unknown>)['nextCursor'];
  if (typeof cursor === 'string' && cursor.length > 0) {
    return cursor;
  }
  return null;
}

/**
 * Parse `orca orchestration worker-list --json` envelope (workers + page.nextCursor).
 */
export function parseWorkerListPage(text: string): OrcaWorkerListPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw schemaError('root', 'invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw schemaError('root', 'expected object');
  }
  const result = (parsed as Record<string, unknown>)['result'];
  if (!result || typeof result !== 'object') {
    throw schemaError('result', 'missing result');
  }
  const rec = result as Record<string, unknown>;
  const workers = rec['workers'];
  if (!Array.isArray(workers)) {
    throw schemaError('result.workers', 'expected array');
  }
  const records = workers.map((row, index) => {
    if (!row || typeof row !== 'object') {
      throw schemaError(`result.workers[${index}]`, 'expected object');
    }
    return recordFromWorkerListRow(row as Record<string, unknown>);
  });
  return {
    records,
    nextCursor: workerListNextCursor(rec),
  };
}

/**
 * Parse `orca orchestration worker-list --json` envelope.
 */
export function parseWorkerListJson(text: string): OrcaSupervisedRecord[] {
  return parseWorkerListPage(text).records;
}

/**
 * Parse `orca orchestration worker-show --json` envelope (no transcript/preview fields).
 */
export function parseWorkerShowJson(text: string): OrcaSupervisedRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw schemaError('root', 'invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw schemaError('root', 'expected object');
  }
  const result = (parsed as Record<string, unknown>)['result'];
  if (!result || typeof result !== 'object') {
    throw schemaError('result', 'missing result');
  }
  const dispatch = (result as Record<string, unknown>)['dispatch'];
  const worker = (result as Record<string, unknown>)['worker'];
  const projection = (result as Record<string, unknown>)['projection'];
  if (!dispatch || typeof dispatch !== 'object') {
    throw schemaError('result.dispatch', 'missing dispatch');
  }
  if (!worker || typeof worker !== 'object') {
    throw schemaError('result.worker', 'missing worker');
  }
  const dispatchRec = dispatch as Record<string, unknown>;
  const workerRec = worker as Record<string, unknown>;
  const hostId = parseHostScope(
    dispatchRec['hostScope'] ?? dispatchRec['host_scope'],
  );
  let hostFromProjection: string | null = null;
  if (projection && typeof projection === 'object') {
    try {
      hostFromProjection = parseHostIdFromProjection(
        projection as Record<string, unknown>,
      );
    } catch {
      hostFromProjection = null;
    }
  }
  return {
    hostId: hostFromProjection ?? hostId,
    runId:
      asNullableString(dispatchRec['runId']) ??
      asNullableString(dispatchRec['run_id']),
    taskId:
      asNullableString(dispatchRec['taskId']) ??
      asNullableString(dispatchRec['task_id']),
    dispatchId:
      asNullableString(dispatchRec['id']) ??
      asNullableString(workerRec['dispatchId']),
    worktreeId: asNullableString(workerRec['worktreeId']),
    agentTerminalHandle:
      asNullableString(workerRec['agentTerminalHandle']) ??
      asNullableString(dispatchRec['assigneeHandle']) ??
      asNullableString(dispatchRec['assignee_handle']),
    providerSessionId: null,
    issueRefHint: null,
  };
}
