import type { DatabaseSync } from 'node:sqlite';
import type { Execution, GitHubIssue, SessionLink, UsageSession, UsageSnapshot } from '../contracts.js';
import type { ClaudeTokenAllocation } from '../codeburn/claude.js';
import type { ProjectMembership } from '../github/memberships.js';
import { dbSnapshotConflict } from './errors.js';
import {
  rowExtrasFingerprint,
  serializeCost,
  serializeTokens,
  snapshotBodyFingerprint,
  type SnapshotRowExtras,
} from './serialize.js';

export type CollectionSource = 'github' | 'orca' | 'codeburn';

export type GitHubImportInput = {
  /** Full Project snapshot when set; stale memberships for this Project are removed. */
  projectId?: string;
  issues: GitHubIssue[];
  memberships: ProjectMembership[];
};

export type CodeBurnImportRow = {
  session: UsageSession;
  snapshot: UsageSnapshot;
  /** Provider session model labels (Claude and Codex). */
  models?: string[] | null;
  /** Per-session model/token allocation semantics when multiple models apply. */
  tokenAllocation?: ClaudeTokenAllocation | null;
  /** CodeBurn project slug hint (not GitHub Project membership). */
  projectHint?: string | null;
  /** @deprecated use `models` */
  claudeModels?: string[] | null;
  /** @deprecated use `tokenAllocation` */
  claudeTokenAllocation?: ClaudeTokenAllocation | null;
  /** @deprecated use `projectHint` */
  claudeProjectHint?: string | null;
};

const SENSITIVE_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /Bearer\s+\S+/g,
];

export function sanitizeCollectionMessage(message: string): string {
  let out = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, '<REDACTED>');
  }
  if (out.length > 2_000) {
    return `${out.slice(0, 2_000)}…`;
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendCollectionLog(
  db: DatabaseSync,
  source: CollectionSource,
  status: 'success' | 'failed',
  message: string,
): void {
  const stmt = db.prepare(
    `INSERT INTO collection_logs (source, status, message, recorded_at)
     VALUES (?, ?, ?, ?)`,
  );
  stmt.run(source, status, sanitizeCollectionMessage(message), nowIso());
}

function extrasFromRow(row: CodeBurnImportRow): SnapshotRowExtras {
  const modelList = row.models ?? row.claudeModels;
  const models =
    modelList && modelList.length > 0 ? JSON.stringify(modelList) : null;
  return {
    claudeModelsJson: models,
    claudeTokenAllocation:
      row.tokenAllocation ?? row.claudeTokenAllocation ?? null,
    claudeProjectHint: row.projectHint ?? row.claudeProjectHint ?? null,
  };
}

function upsertIssue(db: DatabaseSync, issue: GitHubIssue): void {
  db.prepare(
    `INSERT INTO issues (
      issue_node_id, repository_name_with_owner, number, url, title, state,
      parent_issue_node_id, parent_issue_observed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(issue_node_id) DO UPDATE SET
      repository_name_with_owner = excluded.repository_name_with_owner,
      number = excluded.number,
      url = excluded.url,
      title = excluded.title,
      state = excluded.state,
      parent_issue_node_id = CASE WHEN ? = 1
        THEN excluded.parent_issue_node_id ELSE issues.parent_issue_node_id END,
      parent_issue_observed = CASE WHEN ? = 1
        THEN 1 ELSE issues.parent_issue_observed END`,
  ).run(
    issue.issueNodeId,
    issue.repository.nameWithOwner,
    issue.number,
    issue.url,
    issue.title,
    issue.state,
    issue.parentIssueNodeId ?? null,
    issue.parentIssueNodeId === undefined ? 0 : 1,
    issue.parentIssueNodeId === undefined ? 0 : 1,
    issue.parentIssueNodeId === undefined ? 0 : 1,
  );
}

function upsertSnapshotRow(
  db: DatabaseSync,
  snapshot: UsageSnapshot,
  extras: SnapshotRowExtras,
): void {
  const existing = db
    .prepare(
      `SELECT observed_at, tokens_json, cost_amount_usd, cost_kind,
              cost_source_tool, cost_source_version,
              claude_models_json, claude_token_allocation, claude_project_hint
       FROM usage_snapshots WHERE session_key = ?`,
    )
    .get(snapshot.sessionKey) as
    | {
        observed_at: string;
        tokens_json: string;
        cost_amount_usd: number | null;
        cost_kind: string;
        cost_source_tool: string | null;
        cost_source_version: string | null;
        claude_models_json: string | null;
        claude_token_allocation: string | null;
        claude_project_hint: string | null;
      }
    | undefined;

  const cost = serializeCost(snapshot.cost);

  if (!existing) {
    db.prepare(
      `INSERT INTO usage_snapshots (
        session_key, observed_at, tokens_json,
        cost_amount_usd, cost_kind, cost_source_tool, cost_source_version,
        claude_models_json, claude_token_allocation, claude_project_hint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      snapshot.sessionKey,
      snapshot.observedAt,
      serializeTokens(snapshot.tokens),
      cost.amountUsd,
      cost.kind,
      cost.sourceTool,
      cost.sourceVersion,
      extras.claudeModelsJson,
      extras.claudeTokenAllocation,
      extras.claudeProjectHint,
    );
    return;
  }

  if (snapshot.observedAt < existing.observed_at) {
    return;
  }
  if (snapshot.observedAt > existing.observed_at) {
    db.prepare(
      `UPDATE usage_snapshots SET
        observed_at = ?,
        tokens_json = ?,
        cost_amount_usd = ?,
        cost_kind = ?,
        cost_source_tool = ?,
        cost_source_version = ?,
        claude_models_json = ?,
        claude_token_allocation = ?,
        claude_project_hint = ?
       WHERE session_key = ?`,
    ).run(
      snapshot.observedAt,
      serializeTokens(snapshot.tokens),
      cost.amountUsd,
      cost.kind,
      cost.sourceTool,
      cost.sourceVersion,
      extras.claudeModelsJson,
      extras.claudeTokenAllocation,
      extras.claudeProjectHint,
      snapshot.sessionKey,
    );
    return;
  }

  const existingPayload = rowExtrasFingerprint({
    tokens_json: existing.tokens_json,
    cost_amount_usd: existing.cost_amount_usd,
    cost_kind: existing.cost_kind,
    cost_source_tool: existing.cost_source_tool,
    cost_source_version: existing.cost_source_version,
    claude_models_json: existing.claude_models_json,
    claude_token_allocation: existing.claude_token_allocation,
    claude_project_hint: existing.claude_project_hint,
  });
  const newPayload = snapshotBodyFingerprint(snapshot, extras);
  if (existingPayload !== newPayload) {
    throw dbSnapshotConflict(
      `Snapshot at ${snapshot.observedAt} for ${snapshot.sessionKey} conflicts with stored payload.`,
    );
  }
}

export function importGitHubRecords(
  db: DatabaseSync,
  input: GitHubImportInput,
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const projectIds = new Set<string>();
    if (input.projectId !== undefined) {
      projectIds.add(input.projectId);
    }
    for (const m of input.memberships) {
      if (input.projectId !== undefined && m.projectId !== input.projectId) {
        throw new Error('GitHub membership does not belong to the collected Project.');
      }
      projectIds.add(m.projectId);
    }
    const insertProject = db.prepare(
      `INSERT INTO projects (project_id) VALUES (?)
       ON CONFLICT(project_id) DO NOTHING`,
    );
    for (const projectId of projectIds) {
      insertProject.run(projectId);
    }
    for (const issue of input.issues) {
      upsertIssue(db, issue);
    }
    if (input.projectId !== undefined) {
      db.prepare('DELETE FROM project_memberships WHERE project_id = ?').run(input.projectId);
    }
    const insertMembership = db.prepare(
      `INSERT INTO project_memberships (project_id, issue_node_id)
       VALUES (?, ?)
       ON CONFLICT(project_id, issue_node_id) DO NOTHING`,
    );
    for (const m of input.memberships) {
      insertMembership.run(m.projectId, m.issueNodeId);
    }
    db.exec('COMMIT');
    appendCollectionLog(db, 'github', 'success', 'GitHub import completed.');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    const message =
      err instanceof Error ? err.message : 'GitHub import failed.';
    appendCollectionLog(db, 'github', 'failed', message);
    throw err;
  }
}

export function importOrcaExecutions(
  db: DatabaseSync,
  executions: Execution[],
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const stmt = db.prepare(
      `INSERT INTO executions (
        execution_key, host_id, raw_id, run_id, task_id, dispatch_id
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_key) DO UPDATE SET
        host_id = excluded.host_id,
        raw_id = excluded.raw_id,
        run_id = excluded.run_id,
        task_id = excluded.task_id,
        dispatch_id = excluded.dispatch_id`,
    );
    for (const exec of executions) {
      stmt.run(
        exec.executionKey,
        exec.hostId,
        exec.rawId,
        exec.runId,
        exec.taskId,
        exec.dispatchId,
      );
    }
    db.exec('COMMIT');
    appendCollectionLog(db, 'orca', 'success', 'Orca import completed.');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    const message = err instanceof Error ? err.message : 'Orca import failed.';
    appendCollectionLog(db, 'orca', 'failed', message);
    throw err;
  }
}

export function importCodeBurnUsage(
  db: DatabaseSync,
  rows: CodeBurnImportRow[],
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const sessionStmt = db.prepare(
      `INSERT INTO usage_sessions (session_key, provider, source, raw_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET
         provider = excluded.provider,
         source = excluded.source,
         raw_id = excluded.raw_id`,
    );
    for (const row of rows) {
      sessionStmt.run(
        row.session.sessionKey,
        row.session.provider,
        row.session.source,
        row.session.rawId,
      );
      upsertSnapshotRow(db, row.snapshot, extrasFromRow(row));
    }
    db.exec('COMMIT');
    appendCollectionLog(db, 'codeburn', 'success', 'CodeBurn import completed.');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    const message =
      err instanceof Error ? err.message : 'CodeBurn import failed.';
    appendCollectionLog(db, 'codeburn', 'failed', message);
    throw err;
  }
}

export function insertSessionLink(db: DatabaseSync, link: SessionLink): void {
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
}

export function countRows(
  db: DatabaseSync,
  table:
    | 'issues'
    | 'project_memberships'
    | 'executions'
    | 'usage_sessions'
    | 'usage_snapshots'
    | 'collection_logs'
    | 'session_links',
): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
    c: number;
  };
  return row.c;
}
