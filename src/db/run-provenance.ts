import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Each component is UTF-8 encoded as uppercase hex. Colons delimit bytestrings,
// including literal ':' and '%' in Orca IDs, without normalization or ambiguity.
function encodedComponent(value: string): string {
  if (!value || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new TypeError('Run identity components must be nonempty valid UTF-8 strings.');
  }
  return Buffer.from(value, 'utf8').toString('hex').toUpperCase();
}

export function scopedExecutionKey(hostId: string, runId: string, dispatchId: string): string {
  return `orca:supervised:v2:${encodedComponent(hostId)}:${encodedComponent(runId)}:${encodedComponent(dispatchId)}`;
}

export function insertScopedExecution(db: DatabaseSync, identity: {
  hostId: string;
  runId: string;
  taskId: string;
  dispatchId: string;
}): string {
  const key = scopedExecutionKey(identity.hostId, identity.runId, identity.dispatchId);
  db.prepare(`INSERT INTO scoped_executions
    (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
      key, identity.hostId, identity.runId, identity.taskId,
      identity.dispatchId, identity.dispatchId,
    );
  return key;
}

export const VERIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.@-]{0,127}$/;

function verifierHash(verifier: string): string {
  if (!VERIFIER_PATTERN.test(verifier)) {
    throw new TypeError('Verifier must be a short operator identifier.');
  }
  return `sha256:${createHash('sha256').update(verifier).digest('hex')}`;
}

export type ManualEvidenceNote =
  | 'ids_visible_same_session'
  | 'operator_observed_same_session';

// Caller must establish both endpoint IDs in the same observed session. Current
// Orca/agent-top JSON has no verified cross-source identifier, so this API cannot
// produce a stronger verification state than manual_limited.
export function insertManualRoleLink(db: DatabaseSync, input: {
  sessionKey: string;
  role: 'coordinator' | 'worker';
  hostId: string;
  runId: string;
  dispatchId?: string | null;
  linkedAt: string;
  verifier: string;
  evidenceNote?: ManualEvidenceNote | null;
}): void {
  const note = input.evidenceNote ?? null;
  if (note !== null && note !== 'ids_visible_same_session'
    && note !== 'operator_observed_same_session') {
    throw new TypeError('Evidence note is not allowlisted.');
  }
  db.prepare(`INSERT INTO session_role_links
    (session_key, role, host_id, run_id, dispatch_id, method,
      evidence_kind, verification, linked_at, linked_by, evidence_note)
    VALUES (?, ?, ?, ?, ?, 'manual', 'bounded_manual', 'manual_limited', ?, ?, ?)`).run(
      input.sessionKey, input.role, input.hostId, input.runId,
      input.dispatchId ?? null, input.linkedAt, verifierHash(input.verifier), note,
    );
}

export function insertRoleLinkAudit(db: DatabaseSync, input: {
  sessionKey: string;
  role: 'coordinator' | 'worker';
  hostId: string;
  runId: string;
  dispatchId?: string | null;
  linkedAt: string;
  linkedBy: string;
  unlinkedAt: string;
  verifier: string;
}): void {
  db.prepare(`INSERT INTO session_role_link_audit
    (session_key, role, host_id, run_id, dispatch_id, linked_at, linked_by,
      unlinked_at, unlinked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.sessionKey, input.role, input.hostId, input.runId,
      input.dispatchId ?? null, input.linkedAt, input.linkedBy,
      input.unlinkedAt, verifierHash(input.verifier),
    );
}

export type CollectionErrorCode =
  | 'source_unavailable'
  | 'source_invalid_json'
  | 'source_version_unsupported'
  | 'source_error'
  | 'collection_limit'
  | 'storage_error';

export type CollectionCounter =
  | 'runs' | 'tasks' | 'dispatches' | 'workers'
  | 'pages' | 'sessions' | 'snapshots';

const ERROR_CODES: readonly string[] = [
  'source_unavailable', 'source_invalid_json', 'source_version_unsupported',
  'source_error', 'collection_limit', 'storage_error',
];
const COUNTER_NAMES: readonly string[] = [
  'runs', 'tasks', 'dispatches', 'workers', 'pages', 'sessions', 'snapshots',
];

function serializeCounters(
  counters: Partial<Record<CollectionCounter, number>> | null | undefined,
): string | null {
  if (counters == null) return null;
  if (Array.isArray(counters) || typeof counters !== 'object') {
    throw new TypeError('Collection counters must be an object.');
  }
  for (const [key, value] of Object.entries(counters)) {
    if (!COUNTER_NAMES.includes(key) || !Number.isSafeInteger(value)
      || value < 0 || value > 100000) {
      throw new TypeError('Collection counters must use bounded allowlisted integers.');
    }
  }
  return JSON.stringify(counters);
}

export function insertCollectionAttempt(db: DatabaseSync, input: {
  source: 'orca' | 'agent-top';
  hostId?: string | null;
  runId?: string | null;
  provider?: 'claude' | 'codex' | 'cursor' | null;
  startedAt: string;
  completedAt?: string | null;
  status: 'running' | 'success' | 'failed' | 'partial';
  errorCode?: CollectionErrorCode | null;
  counters?: Partial<Record<CollectionCounter, number>> | null;
}): number | bigint {
  const code = input.errorCode ?? null;
  if (code !== null && !ERROR_CODES.includes(code)) {
    throw new TypeError('Collection error code is not allowlisted.');
  }
  const countersJson = serializeCounters(input.counters);
  const result = db.prepare(`INSERT INTO collection_attempts
    (source, host_id, run_id, provider, started_at, completed_at,
      status, error_code, counters_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.source, input.hostId ?? null, input.runId ?? null,
      input.provider ?? null, input.startedAt, input.completedAt ?? null,
      input.status, code, countersJson,
    );
  return result.lastInsertRowid;
}

export function finishAgentTopCollectionAttempt(db: DatabaseSync, input: {
  attemptId: number | bigint;
  provider: 'claude' | 'codex' | 'cursor';
  completedAt: string;
  status: 'success' | 'failed' | 'partial';
  errorCode?: CollectionErrorCode | null;
  counters?: Partial<Record<CollectionCounter, number>> | null;
}): void {
  const code = input.errorCode ?? null;
  if (code !== null && !ERROR_CODES.includes(code)) {
    throw new TypeError('Collection error code is not allowlisted.');
  }
  const countersJson = serializeCounters(input.counters);
  const result = db.prepare(`UPDATE collection_attempts
    SET completed_at = ?, status = ?, error_code = ?, counters_json = ?
    WHERE attempt_id = ? AND source = 'agent-top' AND provider = ?
      AND status = 'running'`).run(
    input.completedAt, input.status, code, countersJson,
    input.attemptId, input.provider,
  );
  if (result.changes !== 1) {
    throw new Error('agent-top collection attempt is not running.');
  }
}

export function finishOrcaCollectionAttempt(db: DatabaseSync, input: {
  attemptId: number | bigint;
  completedAt: string;
  status: 'success' | 'failed' | 'partial';
  errorCode?: CollectionErrorCode | null;
  counters?: Partial<Record<CollectionCounter, number>> | null;
}): void {
  const code = input.errorCode ?? null;
  if (code !== null && !ERROR_CODES.includes(code)) {
    throw new TypeError('Collection error code is not allowlisted.');
  }
  const countersJson = serializeCounters(input.counters);
  const result = db.prepare(`UPDATE collection_attempts
    SET completed_at = ?, status = ?, error_code = ?, counters_json = ?
    WHERE attempt_id = ? AND source = 'orca' AND status = 'running'`).run(
    input.completedAt, input.status, code, countersJson, input.attemptId,
  );
  if (result.changes !== 1) {
    throw new Error('orca collection attempt is not running.');
  }
}

export type PersistOrcaRunProvenanceInput = {
  hostId: string;
  runId: string;
  observedAt: string;
  sourceVersion: string;
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
};

/**
 * Persist a complete Run provenance snapshot under an already-verified storage host id.
 * Idempotent on re-collect of the same `(host_id, run_id)` tuple.
 */
export function persistOrcaRunProvenance(
  db: DatabaseSync,
  input: PersistOrcaRunProvenanceInput,
): void {
  if (!input.hostId || !input.runId || !input.observedAt || !input.sourceVersion) {
    throw new TypeError('persistOrcaRunProvenance requires hostId, runId, observedAt, sourceVersion.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO orca_runs (host_id, run_id, observed_at, source_version)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(host_id, run_id) DO UPDATE SET
        observed_at = excluded.observed_at,
        source_version = excluded.source_version`).run(
      input.hostId, input.runId, input.observedAt, input.sourceVersion,
    );
    const insertTask = db.prepare(`INSERT INTO orca_tasks
      (host_id, run_id, task_id, parent_task_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(host_id, run_id, task_id) DO UPDATE SET
        parent_task_id = excluded.parent_task_id`);
    for (const task of input.tasks) {
      insertTask.run(
        input.hostId, input.runId, task.taskId, task.parentTaskId,
      );
    }
    const insertDispatch = db.prepare(`INSERT INTO orca_dispatches (
        host_id, run_id, task_id, dispatch_id,
        creator_orca_session_id, creator_dispatch_id, retry_of_dispatch_id,
        assignee_orca_session_id, depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(host_id, run_id, dispatch_id) DO UPDATE SET
        task_id = excluded.task_id,
        creator_orca_session_id = excluded.creator_orca_session_id,
        creator_dispatch_id = excluded.creator_dispatch_id,
        retry_of_dispatch_id = excluded.retry_of_dispatch_id,
        assignee_orca_session_id = excluded.assignee_orca_session_id`);
    for (const dispatch of input.dispatches) {
      insertDispatch.run(
        input.hostId, input.runId, dispatch.taskId, dispatch.dispatchId,
        dispatch.creatorOrcaSessionId, dispatch.creatorDispatchId,
        dispatch.retryOfDispatchId, dispatch.assigneeOrcaSessionId,
      );
      const key = scopedExecutionKey(input.hostId, input.runId, dispatch.dispatchId);
      db.prepare(`INSERT INTO scoped_executions
        (execution_key, host_id, run_id, task_id, dispatch_id, raw_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(execution_key) DO NOTHING`).run(
        key, input.hostId, input.runId, dispatch.taskId,
        dispatch.dispatchId, dispatch.dispatchId,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function verifierIdentityHash(verifier: string): string {
  return verifierHash(verifier);
}
