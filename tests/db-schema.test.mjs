import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { sessionKey } from '../dist/contracts.js';
import {
  countRows,
  importUsageSnapshots,
  importGitHubRecords,
  insertSessionLink,
  openTelemetryDatabase,
} from '../dist/db/index.js';

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-schema-'));
  const dbPath = join(dir, 'telemetry.sqlite');
  const handle = openTelemetryDatabase({ dbPath });
  try {
    fn(handle.db);
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const issueA = {
  issueNodeId: 'I_schema_a',
  repository: { nameWithOwner: 'o/r' },
  number: 1,
  url: 'https://github.com/o/r/issues/1',
  title: 'A',
  state: 'OPEN',
};

test('T27: duplicate issue node id upserts not multiplies', () => {
  withDb((db) => {
    importGitHubRecords(db, {
      issues: [issueA],
      memberships: [{ projectId: 'P1', issueNodeId: issueA.issueNodeId }],
    });
    importGitHubRecords(db, {
      issues: [{ ...issueA, title: 'A2' }],
      memberships: [{ projectId: 'P1', issueNodeId: issueA.issueNodeId }],
    });
    assert.equal(countRows(db, 'issues'), 1);
    const row = db
      .prepare('SELECT title FROM issues WHERE issue_node_id = ?')
      .get(issueA.issueNodeId);
    assert.equal(row.title, 'A2');
  });
});

test('T27: duplicate session key upserts session row', () => {
  withDb((db) => {
    const key = sessionKey('claude', 'agent-top', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01');
    const row = {
      session: {
        sessionKey: key,
        provider: 'claude',
        source: 'agent-top',
        rawId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01',
      },
      snapshot: {
        sessionKey: key,
        observedAt: '2026-01-01T00:00:00.000Z',
        tokens: {
          provider: 'claude',
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
        },
        cost: { amountUsd: 0.01, kind: 'estimated_api_equivalent', source: null },
      },
    };
    importUsageSnapshots(db, [row]);
    importUsageSnapshots(db, [row]);
    assert.equal(countRows(db, 'usage_sessions'), 1);
    assert.equal(countRows(db, 'usage_snapshots'), 1);
  });
});

test('T27: second session link for same session is rejected', () => {
  withDb((db) => {
    importGitHubRecords(db, {
      issues: [issueA],
      memberships: [{ projectId: 'P1', issueNodeId: issueA.issueNodeId }],
    });
    const key = sessionKey('codex', 'agent-top', '01a10000-bbbb-4ccc-8ddd-eeeeeeeeee01');
    importUsageSnapshots(db, [
      {
        session: {
          sessionKey: key,
          provider: 'codex',
          source: 'agent-top',
          rawId: '01a10000-bbbb-4ccc-8ddd-eeeeeeeeee01',
        },
        snapshot: {
          sessionKey: key,
          observedAt: '2026-01-01T00:00:00.000Z',
          tokens: {
            provider: 'codex',
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: null,
          },
          cost: { amountUsd: null, kind: 'unknown', source: null },
        },
      },
    ]);
    insertSessionLink(db, {
      sessionKey: key,
      issueNodeId: issueA.issueNodeId,
      method: 'manual',
      linkedAt: '2026-01-02T00:00:00.000Z',
      linkedBy: 'tester',
    });
    assert.throws(() =>
      insertSessionLink(db, {
        sessionKey: key,
        issueNodeId: issueA.issueNodeId,
        method: 'manual',
        linkedAt: '2026-01-03T00:00:00.000Z',
        linkedBy: 'tester',
      }),
    );
  });
});

test('T27: membership FK requires issue', () => {
  withDb((db) => {
    db.prepare('INSERT INTO projects (project_id) VALUES (?)').run('P1');
    assert.throws(() =>
      db
        .prepare(
          'INSERT INTO project_memberships (project_id, issue_node_id) VALUES (?, ?)',
        )
        .run('P1', 'I_missing'),
    );
  });
});
