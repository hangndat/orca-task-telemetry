import { type Execution, orcaExecutionKey } from '../contracts.js';
import { CliError, EXIT_SOURCE_UNAVAILABLE } from '../errors.js';
import type { OrcaSupervisedRecord } from './workers.js';
import type { OrcaManualWorktreeRecord } from './worktrees.js';

export type OrcaExecutionSource = 'supervised' | 'manual';

export type NormalizedOrcaExecution = Execution & {
  source: OrcaExecutionSource;
  worktreeId: string | null;
  issueRefHint: string | null;
  providerSessionId: string | null;
};

function mergeSchemaError(path: string, detail: string): CliError {
  return new CliError({
    code: 'orca_schema_drift',
    message: `Orca merge invalid at ${path}: ${detail}`,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

export function supervisedWorktreeHostKey(
  hostId: string,
  worktreeId: string,
): string {
  return `${hostId}\u0000${worktreeId}`;
}

function supervisedToExecution(record: OrcaSupervisedRecord): NormalizedOrcaExecution {
  const rawId = record.dispatchId!;
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
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (!record.dispatchId) {
      if (record.worktreeId) {
        throw mergeSchemaError(
          `supervised[${i}].dispatchId`,
          'missing dispatchId while worktreeId is present',
        );
      }
      continue;
    }
    out.push(supervisedToExecution(record));
  }
  return out;
}

/**
 * Merge supervised workers with manual worktree fallbacks (dedupe manual when same host+worktree supervised).
 */
export function mergeOrcaExecutions(
  supervised: OrcaSupervisedRecord[],
  manualWorktrees: OrcaManualWorktreeRecord[],
): NormalizedOrcaExecution[] {
  const fromWorkers = normalizeSupervisedRecords(supervised);
  const supervisedWorktreeKeys = new Set<string>();
  for (const record of supervised) {
    if (!record.dispatchId) {
      continue;
    }
    if (record.worktreeId) {
      supervisedWorktreeKeys.add(
        supervisedWorktreeHostKey(record.hostId, record.worktreeId),
      );
    }
  }

  const manualExecutions: NormalizedOrcaExecution[] = [];
  for (const wt of manualWorktrees) {
    const key = supervisedWorktreeHostKey(wt.hostId, wt.worktreeId);
    if (supervisedWorktreeKeys.has(key)) {
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
