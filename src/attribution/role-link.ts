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

// JSON.stringify already escapes \u0000-\u001F, '"', and '\\'; it does not
// escape the C1 control range (\u007F-\u009F) or the Unicode `Cf` (Format)
// general category (e.g. RLO U+202E, which can reorder the *rendered* text
// after it to spoof a different candidate ID on a terminal), so both are
// escaped here. `\p{Cf}` is matched via the Unicode property escape (not an
// enumerated/hand-picked list) so the full, auditable category is covered,
// including deprecated bidi controls (U+206A-U+206F), SOFT HYPHEN (U+00AD),
// interlinear annotation controls (U+FFF9-U+FFFB), and supplementary-plane
// tag characters (U+E0000-U+E007F). Selector IDs come straight from
// stored/raw DB values and must never reach error text/JSON with a raw
// control or format character.
const UNSAFE_RENDER_CHARS = /[\u007F-\u009F\p{Cf}]/gu;

function renderSelectorId(value: string): string {
  return JSON.stringify(value).replace(UNSAFE_RENDER_CHARS, (match) => {
    let escaped = '';
    for (let i = 0; i < match.length; i += 1) {
      escaped += `\\u${match.charCodeAt(i).toString(16).padStart(4, '0')}`;
    }
    return escaped;
  });
}

/** Resolve an omitted coordinator --host only when the Run has exactly one stored host. */
function resolveCoordinatorHost(db: DatabaseSync, runId: string): string {
  const rows = db
    .prepare('SELECT host_id FROM orca_runs WHERE run_id = ? ORDER BY host_id')
    .all(runId) as { host_id: string }[];
  if (rows.length === 1) {
    return rows[0]!.host_id;
  }
  const candidates = `[${rows.map((row) => renderSelectorId(row.host_id)).join(',')}]`;
  if (rows.length === 0) {
    throw roleLinkError(
      'role_link_run_not_found',
      `Run ${renderSelectorId(runId)} is not in the database; candidate host IDs: ${candidates}.`,
      'Collect this Orca Run before linking a role, or pass the exact --host/--run.',
    );
  }
  throw roleLinkError(
    'role_link_run_ambiguous',
    `Run ${renderSelectorId(runId)} matches multiple hosts; candidate host IDs: ${candidates}.`,
    'Pass --host with the exact host ID for this Run.',
  );
}

/**
 * Resolve an omitted worker --host/--run by querying `orca_dispatches`
 * constrained by every selector the caller did supply; a supplied selector is
 * a hard filter, never a hint with fallback. 0 or >1 matching tuples is a
 * safe-candidate error, never a first/default pick.
 */
function resolveWorkerTuple(
  db: DatabaseSync,
  dispatchId: string,
  explicitHostId: string | null,
  explicitRunId: string | null,
): { hostId: string; runId: string } {
  const conditions = ['dispatch_id = ?'];
  const params: string[] = [dispatchId];
  if (explicitHostId !== null) {
    conditions.push('host_id = ?');
    params.push(explicitHostId);
  }
  if (explicitRunId !== null) {
    conditions.push('run_id = ?');
    params.push(explicitRunId);
  }
  const rows = db
    .prepare(
      `SELECT host_id, run_id, dispatch_id FROM orca_dispatches
       WHERE ${conditions.join(' AND ')} ORDER BY host_id, run_id`,
    )
    .all(...params) as { host_id: string; run_id: string; dispatch_id: string }[];
  if (rows.length === 1) {
    return { hostId: rows[0]!.host_id, runId: rows[0]!.run_id };
  }
  const candidates = `[${rows
    .map((row) => `(${renderSelectorId(row.host_id)},${renderSelectorId(row.run_id)},${renderSelectorId(row.dispatch_id)})`)
    .join(',')}]`;
  if (rows.length === 0) {
    throw roleLinkError(
      'role_link_dispatch_not_found',
      `Dispatch ${renderSelectorId(dispatchId)} matches no stored tuple for the given selectors; ` +
        `candidate tuples: ${candidates}.`,
      'Collect this Dispatch before linking a role, or pass the exact --host/--run/--dispatch.',
    );
  }
  throw roleLinkError(
    'role_link_dispatch_ambiguous',
    `Dispatch ${renderSelectorId(dispatchId)} matches multiple tuples; candidate tuples: ${candidates}.`,
    'Pass --host and/or --run to select the exact tuple.',
  );
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
  // Coordinator: optional, inferred only when exactly one orca_runs row has
  // the exact runId. Worker: optional, inferred (with runId) only when the
  // supplied selectors constrain orca_dispatches to exactly one tuple.
  hostId?: string | null;
  // Required for coordinator. Optional for worker (inferred from dispatchId
  // and whichever of hostId/runId is also supplied).
  runId?: string | null;
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
 * database — this never infers or creates Orca/CodeBurn/Issue data. Host/Run
 * selectors may be omitted only when they resolve to exactly one candidate;
 * selection and the write happen inside one BEGIN IMMEDIATE transaction so
 * candidate cardinality cannot change between the check and the insert.
 */
export function linkSessionToRole(db: DatabaseSync, input: LinkRoleInput): LinkRoleResult {
  const key = sessionKey(input.provider, 'codeburn', input.rawSessionId);

  db.exec('BEGIN IMMEDIATE');
  try {
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

    let hostId: string;
    let runId: string;
    if (input.role === 'worker') {
      if (!input.dispatchId) {
        throw roleLinkError('role_link_dispatch_missing', 'Worker role links require --dispatch.');
      }
      if (input.hostId && input.runId) {
        hostId = input.hostId;
        runId = input.runId;
      } else {
        const resolved = resolveWorkerTuple(db, input.dispatchId, input.hostId ?? null, input.runId ?? null);
        hostId = resolved.hostId;
        runId = resolved.runId;
      }
    } else {
      if (input.dispatchId) {
        throw roleLinkError('role_link_dispatch_unexpected', 'Coordinator role links do not accept --dispatch.');
      }
      if (!input.runId) {
        throw roleLinkError('role_link_run_missing', 'Coordinator role links require --run.');
      }
      runId = input.runId;
      hostId = input.hostId ?? resolveCoordinatorHost(db, runId);
    }

    const runRow = db
      .prepare('SELECT 1 FROM orca_runs WHERE host_id = ? AND run_id = ?')
      .get(hostId, runId);
    if (!runRow) {
      throw roleLinkError(
        'role_link_run_unknown',
        `Run ${renderSelectorId(hostId)}/${renderSelectorId(runId)} is not in the database.`,
        'Collect this Orca Run before linking a role.',
      );
    }

    if (input.role === 'worker') {
      const dispatchRow = db
        .prepare(
          `SELECT 1 FROM orca_dispatches
           WHERE host_id = ? AND run_id = ? AND dispatch_id = ?`,
        )
        .get(hostId, runId, input.dispatchId!);
      if (!dispatchRow) {
        throw roleLinkError(
          'role_link_dispatch_unknown',
          `Dispatch ${renderSelectorId(input.dispatchId!)} is not in Run ` +
            `${renderSelectorId(hostId)}/${renderSelectorId(runId)}.`,
          'Collect this Dispatch before linking a role.',
        );
      }
    }

    const existing = loadStoredRoleLink(db, key);
    if (existing) {
      const sameTarget =
        existing.role === input.role &&
        existing.hostId === hostId &&
        existing.runId === runId &&
        (existing.dispatchId ?? null) === (input.dispatchId ?? null) &&
        (existing.evidenceNote ?? null) === (input.evidenceNote ?? null);
      if (sameTarget) {
        db.exec('COMMIT');
        return { outcome: 'unchanged', link: existing };
      }
      throw roleLinkError(
        'role_link_conflict',
        `Session ${key} is already linked as ${existing.role} to ` +
          `${renderSelectorId(existing.hostId)}/${renderSelectorId(existing.runId)}` +
          `${existing.dispatchId ? `/${renderSelectorId(existing.dispatchId)}` : ''}.`,
        'Unlink the existing role before creating a different one.',
      );
    }

    insertManualRoleLink(db, {
      sessionKey: key,
      role: input.role,
      hostId,
      runId,
      dispatchId: input.dispatchId ?? null,
      linkedAt: input.linkedAt,
      verifier: input.verifier,
      evidenceNote: input.evidenceNote ?? null,
    });

    const link = loadStoredRoleLink(db, key);
    if (!link) {
      throw roleLinkError('role_link_internal', `Role link for session ${key} did not persist.`);
    }
    db.exec('COMMIT');
    return { outcome: 'created', link };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }
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

  db.exec('BEGIN IMMEDIATE');
  let existing: StoredRoleLink | null;
  try {
    existing = loadStoredRoleLink(db, key);
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
    const deleted = db
      .prepare(
        `DELETE FROM session_role_links
         WHERE session_key = ? AND role = ? AND host_id = ? AND run_id = ?
           AND dispatch_id IS ?`,
      )
      .run(key, existing.role, existing.hostId, existing.runId, existing.dispatchId);
    if (deleted.changes !== 1) {
      throw roleLinkError(
        'role_link_selector_mismatch',
        `Role link for session ${key} does not match the given selectors.`,
        'Pass the exact --role, --host, --run, and --dispatch of the existing link.',
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }

  return { outcome: 'deleted', link: existing as StoredRoleLink };
}
