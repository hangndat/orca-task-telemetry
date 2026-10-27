import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTelemetryDatabase } from '../../dist/db/index.js';

// Synthetic/redacted fixture; no live GitHub, Orca, or agent-top evidence.
export const oidA = 'a'.repeat(40);
export const oidB = 'b'.repeat(40);
export const at = '2026-10-24T00:00:00.000Z';

export function setupTraceDb() {
  const root = mkdtempSync(join(tmpdir(), 'orca-trace-s3-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  execFileSync('mkdir', ['-p', repo, home]);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo });
  const dbPath = join(home, 'telemetry.sqlite');
  const handle = openTelemetryDatabase({ dbPath, gitRoot: repo });
  const db = handle.db;
  db.prepare(`INSERT INTO issues (issue_node_id, repository_name_with_owner, number, url, title, state)
    VALUES ('I_1','o/r',3,'https://github.com/o/r/issues/3','Synthetic','OPEN')`).run();
  for (const [id, cost] of [['s1', 1.25], ['s2', null], ['s3', 'missing']]) {
    const key = `codex:agent-top:${id}`;
    db.prepare(`INSERT INTO usage_sessions (session_key, provider, source, raw_id)
      VALUES (?, 'codex', 'agent-top', ?)`).run(key, id);
    if (cost !== 'missing') db.prepare(`INSERT INTO usage_snapshots
      (session_key, observed_at, tokens_json, cost_amount_usd, cost_kind)
      VALUES (?, ?, ?, ?, ?)`)
      .run(key, at, JSON.stringify({ provider: 'codex', input: 10, output: 2,
        cacheRead: 3, cacheWrite: 0, reasoning: null }), cost,
        cost === null ? 'unknown' : 'estimated_api_equivalent');
    db.prepare(`INSERT INTO session_links (session_key, issue_node_id, method, linked_at)
      VALUES (?, 'I_1', 'manual', ?)`).run(key, at);
  }
  for (const number of [7, 8]) {
    const id = `PR_${number}`;
    db.prepare(`INSERT INTO pull_requests
      (pull_node_id, repository_name_with_owner, number, url, state, is_draft,
       merged_at, head_ref_oid, observed_at)
      VALUES (?, 'o/r', ?, ?, 'OPEN', 1, NULL, ?, ?)`)
      .run(id, number, `https://github.com/o/r/pull/${number}`, oidA, at);
    db.prepare(`INSERT INTO issue_pull_relations
      (issue_node_id, pull_node_id, status, source, last_verified_at)
      VALUES ('I_1', ?, 'verified_current', 'closingIssuesReferences', ?)`)
      .run(id, at);
    db.prepare(`INSERT INTO session_pull_links
      (session_key, issue_node_id, pull_node_id, method, linked_at)
      VALUES ('codex:agent-top:s1', 'I_1', ?, 'manual', ?)`)
      .run(id, at);
    for (const oid of [oidA, oidB]) {
      db.prepare(`INSERT INTO pull_commits (pull_node_id, oid, url, status, last_verified_at)
        VALUES (?, ?, ?, 'verified_current', ?)`)
        .run(id, oid, `https://github.com/o/r/commit/${oid}`, at);
      db.prepare(`INSERT INTO session_commit_links (session_key, pull_node_id, oid, method, linked_at)
        VALUES ('codex:agent-top:s1', ?, ?, 'manual', ?)`)
        .run(id, oid, at);
    }
  }
  return { root, repo, home, dbPath, db, close: () => {
    handle.close(); rmSync(root, { recursive: true, force: true });
  } };
}

export function profile() {
  return { repository: { id: 'R_1', nameWithOwner: 'o/r', url: 'https://github.com/o/r' },
    project: { id: 'P_1', number: 1, url: 'https://github.com/users/o/projects/1',
      owner: { kind: 'user', login: 'o' } }, createdAt: at, updatedAt: at };
}
