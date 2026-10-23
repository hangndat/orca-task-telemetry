import type { DatabaseSync } from 'node:sqlite';
import type {
  GitHubIssue,
  GitHubPullRequest,
  SessionCommitLink,
  SessionPullLink,
} from '../contracts.js';
import type { PullTraceEvidence } from '../github/pull-trace.js';
import { CliError, EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE } from '../errors.js';
import { attributionSessionUnknown } from '../attribution/errors.js';

export type TraceLinkResult<T> = { outcome: 'created' | 'already_linked'; link: T };

function traceConflict(message: string): CliError {
  return new CliError({ code: 'trace_conflict', message, exitCode: EXIT_USAGE });
}

function tracePartial(): CliError {
  return new CliError({
    code: 'trace_partial',
    message: 'GitHub did not provide a complete, verified pull trace.',
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

function unverified(kind: 'issue_pr_unverified' | 'commit_pr_unverified'): CliError {
  return new CliError({
    code: kind,
    message: kind === 'issue_pr_unverified'
      ? 'GitHub closingIssuesReferences does not verify this Issue in the PR.'
      : 'GitHub pullRequest.commits does not verify this commit in the PR.',
    hint: kind === 'issue_pr_unverified'
      ? 'Add a closing Issue relation on GitHub, then retry.'
      : 'Check the full commit OID and current PR commits, then retry.',
    exitCode: EXIT_USAGE,
  });
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  }
}

export function requireManualIssueLink(db: DatabaseSync, key: string, issueNodeId?: string): string {
  const session = db.prepare('SELECT session_key FROM usage_sessions WHERE session_key = ?').get(key);
  if (!session) throw attributionSessionUnknown(key);
  const row = db.prepare('SELECT issue_node_id, method FROM session_links WHERE session_key = ?').get(key) as
    | { issue_node_id: string; method: string } | undefined;
  if (!row || row.method !== 'manual' || (issueNodeId && row.issue_node_id !== issueNodeId)) {
    throw traceConflict(`Session ${key} must have a manual link to the requested Issue first.`);
  }
  return row.issue_node_id;
}

export function requireManualPullLink(db: DatabaseSync, key: string, pullNodeId: string): SessionPullLink {
  requireManualIssueLink(db, key);
  const row = db.prepare(
    `SELECT session_key, issue_node_id, pull_node_id, method, linked_at
     FROM session_pull_links WHERE session_key = ? AND pull_node_id = ?`,
  ).get(key, pullNodeId) as {
    session_key: string; issue_node_id: string; pull_node_id: string; method: string; linked_at: string;
  } | undefined;
  if (!row || row.method !== 'manual') {
    throw traceConflict(`Session ${key} must have a manual link to PR ${pullNodeId} first.`);
  }
  return {
    sessionKey: row.session_key, issueNodeId: row.issue_node_id,
    pullNodeId: row.pull_node_id, method: 'manual', linkedAt: row.linked_at,
  };
}

function requireVerified(evidence: PullTraceEvidence): GitHubPullRequest {
  if (evidence.status !== 'verified_current' || !evidence.pull ||
      !evidence.closingIssueNodeIds || !evidence.commits) throw tracePartial();
  return evidence.pull;
}

function upsertPull(db: DatabaseSync, pull: GitHubPullRequest, observedAt: string): void {
  db.prepare(
    `INSERT INTO pull_requests (
      pull_node_id, repository_name_with_owner, number, url, state, is_draft,
      merged_at, head_ref_oid, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pull_node_id) DO UPDATE SET
      repository_name_with_owner = excluded.repository_name_with_owner,
      number = excluded.number, url = excluded.url, state = excluded.state,
      is_draft = excluded.is_draft, merged_at = excluded.merged_at,
      head_ref_oid = excluded.head_ref_oid, observed_at = excluded.observed_at`,
  ).run(pull.pullNodeId, pull.repository.nameWithOwner, pull.number, pull.url,
    pull.state, pull.isDraft ? 1 : 0, pull.mergedAt, pull.headRefOid, observedAt);
}

function upsertIssueRelation(db: DatabaseSync, issueNodeId: string, pullNodeId: string, at: string): void {
  db.prepare(
    `INSERT INTO issue_pull_relations (
      issue_node_id, pull_node_id, status, source, last_verified_at
    ) VALUES (?, ?, 'verified_current', 'closingIssuesReferences', ?)
    ON CONFLICT(issue_node_id, pull_node_id) DO UPDATE SET
      status = 'verified_current', last_verified_at = excluded.last_verified_at`,
  ).run(issueNodeId, pullNodeId, at);
}

function upsertCommit(db: DatabaseSync, pullNodeId: string, oid: string, url: string, at: string): void {
  db.prepare(
    `INSERT INTO pull_commits (pull_node_id, oid, url, status, last_verified_at)
     VALUES (?, ?, ?, 'verified_current', ?)
     ON CONFLICT(pull_node_id, oid) DO UPDATE SET
       url = excluded.url, status = 'verified_current', last_verified_at = excluded.last_verified_at`,
  ).run(pullNodeId, oid, url, at);
}

function refreshExistingRelations(db: DatabaseSync, pullNodeId: string, evidence: PullTraceEvidence): void {
  requireVerified(evidence);
  const issues = new Set(evidence.closingIssueNodeIds!);
  const commits = new Map(evidence.commits!.map(item => [item.oid, item]));
  const issueRows = db.prepare('SELECT issue_node_id FROM issue_pull_relations WHERE pull_node_id = ?')
    .all(pullNodeId) as { issue_node_id: string }[];
  for (const row of issueRows) {
    db.prepare(
      'UPDATE issue_pull_relations SET status = ?, last_verified_at = ? WHERE issue_node_id = ? AND pull_node_id = ?',
    ).run(issues.has(row.issue_node_id) ? 'verified_current' : 'stale', evidence.observedAt,
      row.issue_node_id, pullNodeId);
  }
  const commitRows = db.prepare('SELECT oid, url FROM pull_commits WHERE pull_node_id = ?')
    .all(pullNodeId) as { oid: string; url: string }[];
  for (const row of commitRows) {
    const observed = commits.get(row.oid);
    db.prepare(
      `UPDATE pull_commits SET status = ?, last_verified_at = ?, url = ?
       WHERE pull_node_id = ? AND oid = ?`,
    ).run(observed ? 'verified_current' : 'stale', evidence.observedAt,
      observed?.url ?? row.url, pullNodeId, row.oid);
  }
}

/** One transaction covers canonical metadata, relation evidence, and the manual link. */
export function storeManualPullLink(
  db: DatabaseSync,
  input: { sessionKey: string; issue: GitHubIssue; evidence: PullTraceEvidence; linkedAt: string },
): TraceLinkResult<SessionPullLink> {
  const pull = requireVerified(input.evidence);
  if (input.evidence.issueRelations[input.issue.issueNodeId]?.status !== 'verified_current' ||
      !input.evidence.closingIssueNodeIds?.includes(input.issue.issueNodeId)) {
    throw unverified('issue_pr_unverified');
  }
  return transaction(db, () => {
    requireManualIssueLink(db, input.sessionKey, input.issue.issueNodeId);
    const issueRow = db.prepare('SELECT issue_node_id FROM issues WHERE issue_node_id = ?')
      .get(input.issue.issueNodeId);
    if (!issueRow) throw traceConflict('The linked Issue is missing from the local database.');
    const existing = db.prepare(
      `SELECT issue_node_id, method, linked_at FROM session_pull_links
       WHERE session_key = ? AND pull_node_id = ?`,
    ).get(input.sessionKey, pull.pullNodeId) as
      | { issue_node_id: string; method: string; linked_at: string } | undefined;
    if (existing && (existing.issue_node_id !== input.issue.issueNodeId || existing.method !== 'manual')) {
      throw traceConflict('The session and PR are already linked through a different Issue.');
    }
    db.prepare(
      `UPDATE issues SET repository_name_with_owner = ?, number = ?, url = ?, title = ?, state = ?
       WHERE issue_node_id = ?`,
    ).run(input.issue.repository.nameWithOwner, input.issue.number, input.issue.url,
      input.issue.title, input.issue.state, input.issue.issueNodeId);
    upsertPull(db, pull, input.evidence.observedAt);
    refreshExistingRelations(db, pull.pullNodeId, input.evidence);
    upsertIssueRelation(db, input.issue.issueNodeId, pull.pullNodeId, input.evidence.observedAt);
    if (!existing) {
      db.prepare(
        `INSERT INTO session_pull_links
         (session_key, issue_node_id, pull_node_id, method, linked_at)
         VALUES (?, ?, ?, 'manual', ?)`,
      ).run(input.sessionKey, input.issue.issueNodeId, pull.pullNodeId, input.linkedAt);
    }
    return {
      outcome: existing ? 'already_linked' : 'created',
      link: {
        sessionKey: input.sessionKey, issueNodeId: input.issue.issueNodeId,
        pullNodeId: pull.pullNodeId, method: 'manual',
        linkedAt: existing?.linked_at ?? input.linkedAt,
      },
    };
  });
}

/** Commit link requires a prior manual session→PR row and current commit membership. */
export function storeManualCommitLink(
  db: DatabaseSync,
  input: { sessionKey: string; oid: string; evidence: PullTraceEvidence; linkedAt: string },
): TraceLinkResult<SessionCommitLink> {
  const pull = requireVerified(input.evidence);
  const oid = input.oid.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(oid)) throw traceConflict('Commit OID must be a full 40-character Git SHA-1.');
  const commit = input.evidence.commits?.find(item => item.oid === oid);
  if (input.evidence.commitRelations[oid]?.status !== 'verified_current' || !commit) {
    throw unverified('commit_pr_unverified');
  }
  return transaction(db, () => {
    requireManualPullLink(db, input.sessionKey, pull.pullNodeId);
    const existing = db.prepare(
      `SELECT method, linked_at FROM session_commit_links
       WHERE session_key = ? AND pull_node_id = ? AND oid = ?`,
    ).get(input.sessionKey, pull.pullNodeId, oid) as
      | { method: string; linked_at: string } | undefined;
    if (existing && existing.method !== 'manual') throw traceConflict('Conflicting commit link provenance.');
    upsertPull(db, pull, input.evidence.observedAt);
    refreshExistingRelations(db, pull.pullNodeId, input.evidence);
    upsertCommit(db, pull.pullNodeId, oid, commit.url, input.evidence.observedAt);
    if (!existing) {
      db.prepare(
        `INSERT INTO session_commit_links
         (session_key, pull_node_id, oid, method, linked_at)
         VALUES (?, ?, ?, 'manual', ?)`,
      ).run(input.sessionKey, pull.pullNodeId, oid, input.linkedAt);
    }
    return {
      outcome: existing ? 'already_linked' : 'created',
      link: {
        sessionKey: input.sessionKey, pullNodeId: pull.pullNodeId, oid,
        method: 'manual', linkedAt: existing?.linked_at ?? input.linkedAt,
      },
    };
  });
}

/** Refresh stored audit evidence without removing manual links or usage snapshots. */
export function refreshStoredPullTrace(db: DatabaseSync, pullNodeId: string, evidence: PullTraceEvidence): void {
  transaction(db, () => {
    const known = db.prepare('SELECT pull_node_id FROM pull_requests WHERE pull_node_id = ?').get(pullNodeId);
    if (!known) throw traceConflict(`PR ${pullNodeId} is not stored.`);
    if (evidence.status === 'unknown') {
      db.prepare("UPDATE issue_pull_relations SET status = 'unknown' WHERE pull_node_id = ?").run(pullNodeId);
      db.prepare("UPDATE pull_commits SET status = 'unknown' WHERE pull_node_id = ?").run(pullNodeId);
      return;
    }
    const pull = requireVerified(evidence);
    if (pull.pullNodeId !== pullNodeId) throw traceConflict('GitHub PR identity changed during refresh.');
    upsertPull(db, pull, evidence.observedAt);
    refreshExistingRelations(db, pullNodeId, evidence);
  });
}
