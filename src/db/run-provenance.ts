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

function verifierHash(verifier: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.@-]{0,127}$/.test(verifier)) {
    throw new TypeError('Verifier must be a short operator identifier.');
  }
  return `sha256:${createHash('sha256').update(verifier).digest('hex')}`;
}

export type ManualEvidenceNote =
  | 'ids_visible_same_session'
  | 'operator_observed_same_session';

// Caller must establish both endpoint IDs in the same observed session. Current
// Orca/CodeBurn JSON has no verified cross-source identifier, so this API cannot
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

export function insertCollectionAttempt(db: DatabaseSync, input: {
  source: 'orca' | 'codeburn';
  hostId?: string | null;
  runId?: string | null;
  provider?: 'claude' | 'codex' | null;
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
  const counters = input.counters ?? null;
  if (counters !== null) {
    if (Array.isArray(counters) || typeof counters !== 'object') {
      throw new TypeError('Collection counters must be an object.');
    }
    for (const [key, value] of Object.entries(counters)) {
      if (!COUNTER_NAMES.includes(key) || !Number.isSafeInteger(value)
        || value < 0 || value > 100000) {
        throw new TypeError('Collection counters must use bounded allowlisted integers.');
      }
    }
  }
  const result = db.prepare(`INSERT INTO collection_attempts
    (source, host_id, run_id, provider, started_at, completed_at,
      status, error_code, counters_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.source, input.hostId ?? null, input.runId ?? null,
      input.provider ?? null, input.startedAt, input.completedAt ?? null,
      input.status, code, counters === null ? null : JSON.stringify(counters),
    );
  return result.lastInsertRowid;
}

export function verifierIdentityHash(verifier: string): string {
  return verifierHash(verifier);
}
