import { type Execution, orcaExecutionKey } from '../contracts.js';
import type { OrcaSupervisedRecord } from './workers.js';
import type { OrcaManualWorktreeRecord } from './worktrees.js';

export type OrcaExecutionSource = 'supervised' | 'manual';

export type NormalizedOrcaExecution = Execution & {
  source: OrcaExecutionSource;
  worktreeId: string | null;
  issueRefHint: string | null;
  providerSessionId: string | null;
};

function supervisedToExecution(record: OrcaSupervisedRecord): NormalizedOrcaExecution | null {
  if (!record.dispatchId) {
    return null;
  }
  const rawId = record.dispatchId;
  return {
    executionKey: orcaExecutionKey(record.hostId, rawId),
    hostId: record.hostId,
    rawId,
    runId: record.runId,
    taskId: record.taskId,
    dispatchId: record.dispatchId,
    source: 'supervised',
    worktreeId: record.worktreeId,
    issueRefHint: record.issueRefHint,
    providerSessionId: record.providerSessionId,
  };
}

function manualToExecution(record: OrcaManualWorktreeRecord): NormalizedOrcaExecution {
  const rawId = record.worktreeId;
  return {
    executionKey: orcaExecutionKey(record.hostId, rawId),
    hostId: record.hostId,
    rawId,
    runId: null,
    taskId: null,
    dispatchId: null,
    source: 'manual',
    worktreeId: record.worktreeId,
    issueRefHint: record.issueRefHint,
    providerSessionId: null,
  };
}

/**
 * Map supervised worker records to executions (one per dispatch).
 */
export function normalizeSupervisedRecords(
  records: OrcaSupervisedRecord[],
): NormalizedOrcaExecution[] {
  const out: NormalizedOrcaExecution[] = [];
  for (const record of records) {
    const exec = supervisedToExecution(record);
    if (exec) {
      out.push(exec);
    }
  }
  return out;
}

/**
 * Merge supervised workers with manual worktree fallbacks (dedupe manual when worktree already supervised).
 */
export function mergeOrcaExecutions(
  supervised: OrcaSupervisedRecord[],
  manualWorktrees: OrcaManualWorktreeRecord[],
): NormalizedOrcaExecution[] {
  const fromWorkers = normalizeSupervisedRecords(supervised);
  const supervisedWorktreeIds = new Set(
    supervised
      .map((r) => r.worktreeId)
      .filter((id): id is string => id !== null && id.length > 0),
  );

  const manualExecutions: NormalizedOrcaExecution[] = [];
  for (const wt of manualWorktrees) {
    if (supervisedWorktreeIds.has(wt.worktreeId)) {
      continue;
    }
    manualExecutions.push(manualToExecution(wt));
  }

  const byKey = new Map<string, NormalizedOrcaExecution>();
  for (const exec of [...fromWorkers, ...manualExecutions]) {
    byKey.set(exec.executionKey, exec);
  }
  return [...byKey.values()].sort((a, b) =>
    a.executionKey.localeCompare(b.executionKey),
  );
}
