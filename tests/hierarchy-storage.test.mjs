import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { openTelemetryDatabase, importGitHubRecords, SUPPORTED_SCHEMA_VERSION } from '../dist/db/index.js';
import { MIGRATION_V1_STATEMENTS } from '../dist/db/migrations/v1.js';

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'hierarchy-storage-'));
  const handle = openTelemetryDatabase({ dbPath: join(dir, 'telemetry.sqlite') });
  try {
    return run(handle.db);
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function issue(id, parentIssueNodeId) {
  return {
    issueNodeId: id,
    parentIssueNodeId,
    repository: { nameWithOwner: 'org/repo' },
    number: Number(id.slice(1)),
    url: `https://github.com/org/repo/issues/${Number(id.slice(1))}`,
    title: id,
    state: 'OPEN',
  };
}

test('V1.1: parent change and null clear are idempotent; identity-only link lookup preserves parent', () => {
  withDb((db) => {
    const importProject = (issues) => importGitHubRecords(db, {
      projectId: 'P',
      issues,
      memberships: issues.map((i) => ({ projectId: 'P', issueNodeId: i.issueNodeId })),
    });
    importProject([issue('I1', null), issue('I2', 'I1')]);
    importProject([issue('I1', null), issue('I2', 'I1')]);
    let row = db.prepare('SELECT parent_issue_node_id, parent_issue_observed FROM issues WHERE issue_node_id = ?').get('I2');
    assert.equal(row.parent_issue_node_id, 'I1');
    assert.equal(row.parent_issue_observed, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM project_memberships').get().n, 2);

    importGitHubRecords(db, { issues: [issue('I2')], memberships: [] });
    row = db.prepare('SELECT parent_issue_node_id FROM issues WHERE issue_node_id = ?').get('I2');
    assert.equal(row.parent_issue_node_id, 'I1');

    importProject([issue('I2', null)]);
    row = db.prepare('SELECT parent_issue_node_id, parent_issue_observed FROM issues WHERE issue_node_id = ?').get('I2');
    assert.equal(row.parent_issue_node_id, null);
    assert.equal(row.parent_issue_observed, 1);
    assert.deepEqual(
      db.prepare('SELECT issue_node_id FROM project_memberships WHERE project_id = ?').all('P').map((r) => r.issue_node_id),
      ['I2'],
    );

    importProject([]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM project_memberships WHERE project_id = ?').get('P').n, 0);
  });
});

test('V1.1: schema v1 migrates to current without losing existing issue and link rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hierarchy-migrate-'));
  const dbPath = join(dir, 'telemetry.sqlite');
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA foreign_keys = ON');
    for (const statement of MIGRATION_V1_STATEMENTS) raw.exec(statement);
    raw.exec('PRAGMA user_version = 1');
    raw.prepare('INSERT INTO projects (project_id) VALUES (?)').run('P');
    raw.prepare('INSERT INTO issues (issue_node_id, repository_name_with_owner, number, url, title, state) VALUES (?, ?, ?, ?, ?, ?)')
      .run('I1', 'org/repo', 1, 'https://github.com/org/repo/issues/1', 'Old issue', 'OPEN');
    raw.prepare('INSERT INTO project_memberships (project_id, issue_node_id) VALUES (?, ?)').run('P', 'I1');
    raw.prepare('INSERT INTO usage_sessions (session_key, provider, source, raw_id) VALUES (?, ?, ?, ?)')
      .run('claude:codeburn:old', 'claude', 'codeburn', 'old');
    raw.prepare('INSERT INTO usage_snapshots (session_key, observed_at, tokens_json, cost_amount_usd, cost_kind) VALUES (?, ?, ?, ?, ?)')
      .run('claude:codeburn:old', '2026-01-01T00:00:00Z', '{"provider":"claude","input":1,"output":2,"cacheRead":0,"cacheWrite":0}', 0.2, 'estimated_api_equivalent');
    raw.prepare('INSERT INTO session_links (session_key, issue_node_id, method, linked_at) VALUES (?, ?, ?, ?)')
      .run('claude:codeburn:old', 'I1', 'manual', '2026-01-01T00:00:00Z');
  } finally {
    raw.close();
  }
  const handle = openTelemetryDatabase({ dbPath });
  try {
    assert.equal(handle.db.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
    const row = handle.db.prepare('SELECT issue_node_id, parent_issue_node_id, parent_issue_observed FROM issues').get();
    assert.equal(row.issue_node_id, 'I1');
    assert.equal(row.parent_issue_node_id, null);
    assert.equal(row.parent_issue_observed, 0);
    assert.equal(handle.db.prepare('SELECT count(*) AS n FROM project_memberships').get().n, 1);
    assert.equal(handle.db.prepare('SELECT count(*) AS n FROM session_links').get().n, 1);
    assert.equal(handle.db.prepare('SELECT cost_amount_usd FROM usage_snapshots').get().cost_amount_usd, 0.2);
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
