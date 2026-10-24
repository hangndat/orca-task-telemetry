import type { DatabaseSync } from 'node:sqlite';
import { sessionKey, type UsageProvider } from '../contracts.js';
import {
  insertManualRoleLink,
  insertRoleLinkAudit,
  type ManualEvidenceNote,
} from '../db/run-provenance.js';
import { CliError, EXIT_USAGE } from '../errors.js';

export type RoleLinkRole = 'coordinator' | 'worker';

export type StoredRoleLink = {
  sessionKey: string;
  role: RoleLinkRole;
  hostId: string;
  runId: string;
  dispatchId: string | null;
  linkedAt: string;
  linkedBy: string;
  evidenceNote: ManualEvidenceNote | null;
};

function roleLinkError(code: string, message: string, hint?: string): CliError {
  return new CliError({ code, message, hint, exitCode: EXIT_USAGE });
}

function loadStoredRoleLink(db: DatabaseSync, key: string): StoredRoleLink | null {
  const row = db
    .prepare(
      `SELECT session_key, role, host_id, run_id, dispatch_id, linked_at,
        linked_by, evidence_note
       FROM session_role_links WHERE session_key = ?`,
    )
    .get(key) as
    | {
        session_key: string;
        role: RoleLinkRole;
        host_id: string;
        run_id: string;
        dispatch_id: string | null;
        linked_at: string;
        linked_by: string;
        evidence_note: ManualEvidenceNote | null;
      }
    | undefined;
  if (!row) {
    return null;
  }
  return {
    sessionKey: row.session_key,
    role: row.role,
    hostId: row.host_id,
    runId: row.run_id,
    dispatchId: row.dispatch_id,
    linkedAt: row.linked_at,
    linkedBy: row.linked_by,
    evidenceNote: row.evidence_note,
  };
}

export type LinkRoleInput = {
  provider: UsageProvider;
  rawSessionId: string;
  role: RoleLinkRole;
  hostId: string;
  runId: string;
  dispatchId?: string | null;
  verifier: string;
  evidenceNote?: ManualEvidenceNote | null;
  linkedAt: string;
};

export type LinkRoleOutcome = 'created' | 'unchanged';
export type LinkRoleResult = { outcome: LinkRoleOutcome; link: StoredRoleLink };

/**
 * Link one usage session to a coordinator/worker role of one Orca Run or Dispatch.
 * Requires the session, Run, and (for worker) Dispatch to already be in the
 * database — this never infers or creates Orca/CodeBurn/Issue data.
 */
export function linkSessionToRole(db: DatabaseSync, input: LinkRoleInput): LinkRoleResult {
  const key = sessionKey(input.provider, 'codeburn', input.rawSessionId);

  const sessionRow = db
    .prepare('SELECT session_key FROM usage_sessions WHERE session_key = ?')
    .get(key);
  if (!sessionRow) {
    throw roleLinkError(
      'role_link_session_unknown',
      `Usage session ${key} is not in the database.`,
      'Collect CodeBurn sessions before linking a role.',
    );
  }

  const runRow = db
    .prepare('SELECT 1 FROM orca_runs WHERE host_id = ? AND run_id = ?')
    .get(input.hostId, input.runId);
  if (!runRow) {
    throw roleLinkError(
      'role_link_run_unknown',
      `Run ${input.hostId}/${input.runId} is not in the database.`,
      'Collect this Orca Run before linking a role.',
    );
  }

  if (input.role === 'worker') {
    if (!input.dispatchId) {
      throw roleLinkError('role_link_dispatch_missing', 'Worker role links require --dispatch.');
    }
    const dispatchRow = db
      .prepare(
        `SELECT 1 FROM orca_dispatches
         WHERE host_id = ? AND run_id = ? AND dispatch_id = ?`,
      )
      .get(input.hostId, input.runId, input.dispatchId);
    if (!dispatchRow) {
      throw roleLinkError(
        'role_link_dispatch_unknown',
        `Dispatch ${input.dispatchId} is not in Run ${input.hostId}/${input.runId}.`,
        'Collect this Dispatch before linking a role.',
      );
    }
  } else if (input.dispatchId) {
    throw roleLinkError('role_link_dispatch_unexpected', 'Coordinator role links do not accept --dispatch.');
  }

  const existing = loadStoredRoleLink(db, key);
  if (existing) {
    const sameTarget =
      existing.role === input.role &&
      existing.hostId === input.hostId &&
      existing.runId === input.runId &&
      (existing.dispatchId ?? null) === (input.dispatchId ?? null) &&
      (existing.evidenceNote ?? null) === (input.evidenceNote ?? null);
    if (sameTarget) {
      return { outcome: 'unchanged', link: existing };
    }
    throw roleLinkError(
      'role_link_conflict',
      `Session ${key} is already linked as ${existing.role} to ` +
        `${existing.hostId}/${existing.runId}${existing.dispatchId ? `/${existing.dispatchId}` : ''}.`,
      'Unlink the existing role before creating a different one.',
    );
  }

  insertManualRoleLink(db, {
    sessionKey: key,
    role: input.role,
    hostId: input.hostId,
    runId: input.runId,
    dispatchId: input.dispatchId ?? null,
    linkedAt: input.linkedAt,
    verifier: input.verifier,
    evidenceNote: input.evidenceNote ?? null,
  });

  const link = loadStoredRoleLink(db, key);
  if (!link) {
    throw roleLinkError('role_link_internal', `Role link for session ${key} did not persist.`);
  }
  return { outcome: 'created', link };
}

export type UnlinkRoleInput = {
  provider: UsageProvider;
  rawSessionId: string;
  role: RoleLinkRole;
  hostId: string;
  runId: string;
  dispatchId?: string | null;
  verifier: string;
  unlinkedAt: string;
};

export type UnlinkRoleResult = { outcome: 'deleted'; link: StoredRoleLink };

/**
 * Unlink a role from one usage session. The selectors must match the existing
 * link exactly (no fuzzy/partial match); the old link and both verifiers are
 * written to a durable audit row, atomically with the delete. No raw evidence
 * or prompt content is ever stored, during link or unlink.
 */
export function unlinkSessionRole(db: DatabaseSync, input: UnlinkRoleInput): UnlinkRoleResult {
  const key = sessionKey(input.provider, 'codeburn', input.rawSessionId);
  const existing = loadStoredRoleLink(db, key);
  if (!existing) {
    throw roleLinkError('role_link_not_found', `No role link exists for session ${key}.`);
  }
  const matchesSelectors =
    existing.role === input.role &&
    existing.hostId === input.hostId &&
    existing.runId === input.runId &&
    (existing.dispatchId ?? null) === (input.dispatchId ?? null);
  if (!matchesSelectors) {
    throw roleLinkError(
      'role_link_selector_mismatch',
      `Role link for session ${key} does not match the given selectors.`,
      'Pass the exact --role, --host, --run, and --dispatch of the existing link.',
    );
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    insertRoleLinkAudit(db, {
      sessionKey: existing.sessionKey,
      role: existing.role,
      hostId: existing.hostId,
      runId: existing.runId,
      dispatchId: existing.dispatchId,
      linkedAt: existing.linkedAt,
      linkedBy: existing.linkedBy,
      unlinkedAt: input.unlinkedAt,
      verifier: input.verifier,
    });
    db.prepare('DELETE FROM session_role_links WHERE session_key = ?').run(key);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }

  return { outcome: 'deleted', link: existing };
}
