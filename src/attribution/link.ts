import type { DatabaseSync } from 'node:sqlite';
import {
  sessionKey,
  type SessionLink,
  type UsageProvider,
  type UsageSource,
  USAGE_SOURCES,
} from '../contracts.js';
import {
  attributionIssueUnknown,
  attributionLinkConflict,
  attributionSessionUnknown,
} from './errors.js';

export type LinkSessionInput = {
  provider: UsageProvider;
  source: UsageSource;
  rawSessionId: string;
  issueNodeId: string;
  linkedAt: string;
};

export type LinkSessionOutcome = 'created' | 'unchanged';

export type LinkSessionResult = {
  outcome: LinkSessionOutcome;
  link: SessionLink;
};

function assertKnownSource(source: UsageSource): void {
  if (!(USAGE_SOURCES as readonly string[]).includes(source)) {
    throw attributionSessionUnknown(`unknown source ${source}`);
  }
}

function loadExistingLink(
  db: DatabaseSync,
  sessionKeyValue: string,
): SessionLink | null {
  const row = db
    .prepare(
      `SELECT session_key, issue_node_id, method, linked_at, linked_by
       FROM session_links WHERE session_key = ?`,
    )
    .get(sessionKeyValue) as
    | {
        session_key: string;
        issue_node_id: string;
        method: string;
        linked_at: string;
        linked_by: string | null;
      }
    | undefined;
  if (!row) {
    return null;
  }
  return {
    sessionKey: row.session_key,
    issueNodeId: row.issue_node_id,
    method: 'manual',
    linkedAt: row.linked_at,
    linkedBy: row.linked_by,
  };
}

/**
 * Link one usage session to one Issue (explicit provider + source + raw session id).
 */
export function linkSessionToIssue(
  db: DatabaseSync,
  input: LinkSessionInput,
): LinkSessionResult {
  assertKnownSource(input.source);
  const key = sessionKey(input.provider, input.source, input.rawSessionId);

  const sessionRow = db
    .prepare('SELECT session_key FROM usage_sessions WHERE session_key = ?')
    .get(key);
  if (!sessionRow) {
    throw attributionSessionUnknown(key);
  }

  const issueRow = db
    .prepare('SELECT issue_node_id FROM issues WHERE issue_node_id = ?')
    .get(input.issueNodeId);
  if (!issueRow) {
    throw attributionIssueUnknown(input.issueNodeId);
  }

  const existing = loadExistingLink(db, key);
  if (existing) {
    if (existing.issueNodeId !== input.issueNodeId) {
      throw attributionLinkConflict(key, existing.issueNodeId);
    }
    return { outcome: 'unchanged', link: existing };
  }

  const link: SessionLink = {
    sessionKey: key,
    issueNodeId: input.issueNodeId,
    method: 'manual',
    linkedAt: input.linkedAt,
    linkedBy: null,
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO session_links (
        session_key, issue_node_id, method, linked_at, linked_by
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      link.sessionKey,
      link.issueNodeId,
      link.method,
      link.linkedAt,
      link.linkedBy,
    );
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }

  return { outcome: 'created', link };
}
