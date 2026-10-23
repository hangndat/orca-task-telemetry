import {
  assertSupportedOrcaVersion,
  invokeOrcaReadOnly,
  readOrcaVersion,
  type OrcaAdapterOptions,
  type OrcaInvocationResult,
} from './adapter.js';

/** This boundary contains source metadata only. It never carries CLI receipts, specs or previews. */
export type OrcaRunProvenance = {
  hostId: string;
  runId: string;
  coordinatorHandle: string | null;
  tasks: Array<{ taskId: string; parentTaskId: string | null; status: string | null }>;
  dispatches: Array<{
    dispatchId: string;
    taskId: string;
    creatorOrcaSessionId: string | null;
    creatorDispatchId: string | null;
    retryOfDispatchId: string | null;
    assigneeOrcaSessionId: string | null;
    status: string | null;
  }>;
  workers: Array<{
    dispatchId: string;
    taskId: string;
    agentTerminalHandle: string | null;
    worktreeId: string | null;
    terminalState: string | null;
  }>;
  pagesRead: number;
  complete: boolean;
  errors: Array<{ source: 'run-show' | 'task-list' | 'dispatch-show' | 'worker-list'; code: string }>;
};

export type RunProvenanceOptions = OrcaAdapterOptions & {
  /** Explicit host selected by the caller from the Orca endpoint being queried. */
  sourceHostId: string;
  /** Test seam. Production uses the existing read-only, version-checked adapter. */
  invoke?: (argv: string[]) => Promise<OrcaInvocationResult>;
  readVersion?: () => Promise<string>;
};

const MAX_PAGES = 100;
const MAX_ROWS = 10_000;
const MAX_TASKS = 10_000;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullable(value: unknown): string | null {
  return id(value);
}

function hostScope(value: unknown): string | null {
  try {
    const scope = object(typeof value === 'string' ? JSON.parse(value) as unknown : value);
    return id(scope?.['hostId']);
  } catch {
    return null;
  }
}

function receipt(stdout: string): Record<string, unknown> | null {
  try {
    const root = object(JSON.parse(stdout) as unknown);
    return root?.['ok'] === true ? object(root['result']) : null;
  } catch {
    return null;
  }
}

function isTruncated(value: Record<string, unknown>): boolean {
  return value['truncated'] === true || value['hasMore'] === true ||
    value['nextCursor'] !== undefined && value['nextCursor'] !== null ||
    object(value['page'])?.['hasMore'] === true;
}

/** Read one explicit Run. Any gap leaves complete=false; no missing row is synthesized. */
export async function collectOrcaRunProvenance(
  runId: string,
  options: RunProvenanceOptions,
): Promise<OrcaRunProvenance> {
  if (!id(runId) || !id(options.sourceHostId)) {
    throw new Error('runId and sourceHostId must be explicit non-empty strings');
  }
  const invoke = options.invoke ?? ((argv: string[]) => invokeOrcaReadOnly(argv, options));
  const version = await (options.readVersion?.() ?? readOrcaVersion(options));
  assertSupportedOrcaVersion(version);
  const out: OrcaRunProvenance = {
    hostId: options.sourceHostId,
    runId,
    coordinatorHandle: null,
    tasks: [], dispatches: [], workers: [], pagesRead: 0,
    complete: false, errors: [],
  };
  const fail = (source: OrcaRunProvenance['errors'][number]['source'], code: string) => {
    out.errors.push({ source, code });
  };
  const call = async (source: OrcaRunProvenance['errors'][number]['source'], argv: string[]) => {
    try {
      const result = receipt((await invoke(argv)).stdout);
      if (!result) fail(source, 'invalid_receipt');
      return result;
    } catch {
      fail(source, 'source_failure');
      return null;
    }
  };

  const runResult = await call('run-show', ['orchestration', 'run-show', '--id', runId, '--json']);
  const run = object(runResult?.['run']);
  if (!run || id(run['id']) !== runId) fail('run-show', 'run_mismatch');
  else out.coordinatorHandle = nullable(run['coordinator_handle']);

  const taskResult = await call('task-list', ['orchestration', 'task-list', '--run', runId, '--brief', '--json']);
  const taskRows = taskResult?.['tasks'];
  const taskIds = new Set<string>();
  if (!Array.isArray(taskRows)) fail('task-list', 'invalid_tasks');
  else {
    const count = taskResult?.['count'];
    if (!Number.isSafeInteger(count) || count !== taskRows.length || isTruncated(taskResult!) ||
      taskRows.length > MAX_TASKS) {
      fail('task-list', 'unprovable_completeness');
    }
    for (const row of taskRows.slice(0, MAX_TASKS)) {
      const task = object(row);
      const taskId = id(task?.['id']);
      if (!taskId || id(task?.['run_id']) !== runId) { fail('task-list', 'task_mismatch'); continue; }
      if (taskIds.has(taskId)) { fail('task-list', 'duplicate_task'); continue; }
      taskIds.add(taskId);
      out.tasks.push({ taskId, parentTaskId: nullable(task?.['parent_id']), status: nullable(task?.['status']) });
    }
  }

  const dispatchIds = new Set<string>();
  let verifiedHost = false;
  for (const task of out.tasks) {
    const result = await call('dispatch-show', ['orchestration', 'dispatch-show', '--task', task.taskId, '--json']);
    const dispatch = object(result?.['dispatch']);
    if (!dispatch) { fail('dispatch-show', 'invalid_dispatch'); continue; }
    const dispatchId = id(dispatch['id']);
    const sourceHost = hostScope(dispatch['host_scope'] ?? dispatch['hostScope']);
    if (!dispatchId || id(dispatch['run_id'] ?? dispatch['runId']) !== runId ||
      id(dispatch['task_id'] ?? dispatch['taskId']) !== task.taskId) {
      fail('dispatch-show', 'dispatch_mismatch'); continue;
    }
    if (sourceHost !== options.sourceHostId) { fail('dispatch-show', 'host_mismatch'); continue; }
    verifiedHost = true;
    if (dispatchIds.has(dispatchId)) { fail('dispatch-show', 'duplicate_dispatch'); continue; }
    dispatchIds.add(dispatchId);
    out.dispatches.push({
      dispatchId, taskId: task.taskId,
      creatorOrcaSessionId: nullable(dispatch['creator_orca_session_id']),
      creatorDispatchId: nullable(dispatch['creator_dispatch_id']),
      retryOfDispatchId: nullable(dispatch['retry_of_dispatch_id']),
      assigneeOrcaSessionId: nullable(dispatch['assignee_orca_session_id']),
      status: nullable(dispatch['status']),
    });
  }

  const cursors = new Set<string>();
  const workerIds = new Set<string>();
  let cursor: string | null = null;
  let expectedWorkerTotal: number | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const argv = ['orchestration', 'worker-list', '--run', runId, '--limit', '100', '--json'];
    if (cursor !== null) argv.push('--cursor', cursor);
    const result = await call('worker-list', argv);
    if (!result) break;
    out.pagesRead += 1;
    const scope = object(result['scope']);
    const page = object(result['page']);
    const rows = result['workers'];
    if (id(scope?.['run']) !== runId || scope?.['source'] !== 'flag' ||
      !page || !Array.isArray(rows) || rows.length > 100 ||
      !Number.isSafeInteger(page['total']) || page['limit'] !== 100) {
      fail('worker-list', 'invalid_page'); break;
    }
    if ((page['total'] as number) > MAX_ROWS) { fail('worker-list', 'row_limit'); break; }
    if (expectedWorkerTotal === null) expectedWorkerTotal = page['total'] as number;
    else if (page['total'] !== expectedWorkerTotal) { fail('worker-list', 'total_changed'); break; }
    if (out.workers.length + rows.length > MAX_ROWS) { fail('worker-list', 'row_limit'); break; }
    for (const row of rows) {
      const worker = object(row);
      const projection = object(worker?.['projection']);
      const host = object(projection?.['host']);
      const dispatchId = id(worker?.['dispatchId']);
      const taskId = id(worker?.['taskId']);
      if (!dispatchId || !taskId || id(worker?.['runId']) !== runId ||
        id(projection?.['dispatchId']) !== dispatchId ||
        id(projection?.['taskId']) !== taskId || id(projection?.['runId']) !== runId ||
        id(host?.['id']) !== options.sourceHostId) {
        fail('worker-list', 'worker_mismatch'); continue;
      }
      verifiedHost = true;
      if (workerIds.has(dispatchId)) { fail('worker-list', 'duplicate_worker'); continue; }
      workerIds.add(dispatchId);
      const resource = object(worker?.['resource']);
      out.workers.push({ dispatchId, taskId,
        agentTerminalHandle: nullable(worker?.['agentTerminalHandle']),
        worktreeId: nullable(resource?.['worktreeId']),
        terminalState: nullable(worker?.['terminalState']),
      });
    }
    if (page['hasMore'] !== true) {
      if (page['hasMore'] !== false || page['nextCursor'] !== null ||
        page['total'] !== out.workers.length) fail('worker-list', 'unprovable_completeness');
      break;
    }
    const next = id(page['nextCursor']);
    if (!next || cursors.has(next)) { fail('worker-list', 'cursor_loop'); break; }
    cursors.add(next);
    cursor = next;
    if (pageNumber === MAX_PAGES - 1 || out.workers.length === MAX_ROWS) {
      fail('worker-list', 'page_limit'); break;
    }
  }
  if (!verifiedHost) fail('run-show', 'host_unverified');
  const dispatchTaskById = new Map(out.dispatches.map((dispatch) => [dispatch.dispatchId, dispatch.taskId]));
  for (const worker of out.workers) {
    if (!dispatchIds.has(worker.dispatchId) ||
      dispatchTaskById.get(worker.dispatchId) !== worker.taskId) {
      fail('worker-list', 'orphan_worker');
    }
  }
  for (const dispatch of out.dispatches) {
    if (!workerIds.has(dispatch.dispatchId)) fail('worker-list', 'missing_worker');
  }
  out.complete = out.errors.length === 0;
  return out;
}
