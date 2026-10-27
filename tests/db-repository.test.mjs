import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { orcaExecutionKey, sessionKey } from '../dist/contracts.js';
import { readFileSync } from 'node:fs';
import {
  countRows,
  importUsageSnapshots,
  importGitHubRecords,
  importOrcaExecutions,
  openTelemetryDatabase,
  sanitizeCollectionMessage,
} from '../dist/db/index.js';
import { normalizeProjectMemberships } from '../dist/github/memberships.js';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    joinPath(testDir, 'fixtures/github/synthetic-memberships.json'),
    'utf8',
  ),
);

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-import-'));
  const dbPath = join(dir, 'telemetry.sqlite');
  const handle = openTelemetryDatabase({ dbPath });
  return { ...handle, dir };
}

test('T28: duplicate GitHub import keeps stable row counts', () => {
  const normalized = normalizeProjectMemberships(fixture.items);
  const { db, close, dir } = openTemp();
  importGitHubRecords(db, normalized);
  const afterFirst = {
    issues: countRows(db, 'issues'),
    memberships: countRows(db, 'project_memberships'),
    logs: countRows(db, 'collection_logs'),
  };
  importGitHubRecords(db, normalized);
  assert.deepEqual(
    {
      issues: countRows(db, 'issues'),
      memberships: countRows(db, 'project_memberships'),
    },
    { issues: afterFirst.issues, memberships: afterFirst.memberships },
  );
  assert.equal(countRows(db, 'collection_logs'), afterFirst.logs + 1);
  close();
  rmSync(dir, { recursive: true, force: true });
});

test('T28: newer snapshot replaces, older observedAt is noop', () => {
  const { db, close, dir } = openTemp();
  const key = sessionKey('claude', 'agent-top', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02');
  const base = {
    session: {
      sessionKey: key,
      provider: 'claude',
      source: 'agent-top',
      rawId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02',
    },
  };
  importUsageSnapshots(db, [
    {
      ...base,
      snapshot: {
        sessionKey: key,
        observedAt: '2026-02-01T00:00:00.000Z',
        tokens: {
          provider: 'claude',
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
        },
        cost: { amountUsd: 0.1, kind: 'estimated_api_equivalent', source: null },
      },
    },
  ]);
  importUsageSnapshots(db, [
    {
      ...base,
      snapshot: {
        sessionKey: key,
        observedAt: '2026-03-01T00:00:00.000Z',
        tokens: {
          provider: 'claude',
          input: 99,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        cost: { amountUsd: 0.2, kind: 'estimated_api_equivalent', source: null },
      },
    },
  ]);
  const row = db
    .prepare('SELECT observed_at, tokens_json FROM usage_snapshots WHERE session_key = ?')
    .get(key);
  assert.equal(row.observed_at, '2026-03-01T00:00:00.000Z');
  importUsageSnapshots(db, [
    {
      ...base,
      snapshot: {
        sessionKey: key,
        observedAt: '2026-01-01T00:00:00.000Z',
        tokens: {
          provider: 'claude',
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        cost: { amountUsd: 0.01, kind: 'estimated_api_equivalent', source: null },
      },
    },
  ]);
  const row2 = db
    .prepare('SELECT tokens_json FROM usage_snapshots WHERE session_key = ?')
    .get(key);
  assert.equal(row2.tokens_json, row.tokens_json);
  close();
  rmSync(dir, { recursive: true, force: true });
});

test('T28: same observedAt with conflicting payload throws', () => {
  const { db, close, dir } = openTemp();
  const key = sessionKey('claude', 'agent-top', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee03');
  const observedAt = '2026-04-01T00:00:00.000Z';
  const base = {
    session: {
      sessionKey: key,
      provider: 'claude',
      source: 'agent-top',
      rawId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee03',
    },
  };
  importUsageSnapshots(db, [
    {
      ...base,
      snapshot: {
        sessionKey: key,
        observedAt,
        tokens: {
          provider: 'claude',
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        cost: { amountUsd: 0.1, kind: 'estimated_api_equivalent', source: null },
      },
    },
  ]);
  assert.throws(
    () =>
      importUsageSnapshots(db, [
        {
          ...base,
          snapshot: {
            sessionKey: key,
            observedAt,
            tokens: {
              provider: 'claude',
              input: 2,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
            },
            cost: { amountUsd: 0.1, kind: 'estimated_api_equivalent', source: null },
          },
        },
      ]),
    (err) => err.code === 'db_snapshot_conflict',
  );
  close();
  rmSync(dir, { recursive: true, force: true });
});

test('T28: failed source rolls back only its transaction; prior source remains', () => {
  const normalized = normalizeProjectMemberships(fixture.items);
  const { db, close, dir } = openTemp();
  importGitHubRecords(db, normalized);
  const issuesBefore = countRows(db, 'issues');
  const badKey = 'codex:agent-top:bad';
  assert.throws(() =>
    importUsageSnapshots(db, [
      {
        session: {
          sessionKey: badKey,
          provider: 'claude',
          source: 'agent-top',
          rawId: 'bad',
        },
        snapshot: {
          sessionKey: badKey,
          observedAt: '2026-01-01T00:00:00.000Z',
          tokens: {
            provider: 'claude',
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
          },
          cost: { amountUsd: 0.1, kind: 'estimated_api_equivalent', source: null },
        },
      },
    ]),
  );
  assert.equal(countRows(db, 'issues'), issuesBefore);
  const failed = db
    .prepare(
      "SELECT message FROM collection_logs WHERE source = 'agent-top' AND status = 'failed' ORDER BY log_id DESC LIMIT 1",
    )
    .get();
  assert.ok(failed?.message);
  close();
  rmSync(dir, { recursive: true, force: true });
});

test('T28: Orca import idempotent by execution key', () => {
  const { db, close, dir } = openTemp();
  const exec = {
    executionKey: orcaExecutionKey('local', 'ctx_test_import'),
    hostId: 'local',
    rawId: 'ctx_test_import',
    runId: 'run_1',
    taskId: 'task_1',
    dispatchId: 'ctx_test_import',
  };
  importOrcaExecutions(db, [exec]);
  importOrcaExecutions(db, [exec]);
  assert.equal(countRows(db, 'executions'), 1);
  close();
  rmSync(dir, { recursive: true, force: true });
});

test('T33: codex models persist via generic import aliases', () => {
  const { db, close, dir } = openTemp();
  const observedAt = '2026-06-01T00:00:00.000Z';
  const row = JSON.parse(
    readFileSync(
      joinPath(testDir, 'fixtures/agent-top/codex/session-gpt-small-aggregated.json'),
      'utf8',
    ),
  );
  const key = sessionKey('codex', 'agent-top', row.session_id);
  importUsageSnapshots(db, [
    {
      session: {
        sessionKey: key,
        provider: 'codex',
        source: 'agent-top',
        rawId: row.session_id,
      },
      snapshot: {
        sessionKey: key,
        observedAt,
        tokens: {
          provider: 'codex',
          input: row.input,
          output: row.output,
          cacheRead: row.cache_read,
          cacheWrite: row.cache_write_5m,
          reasoning: null,
        },
        cost: { amountUsd: row.cost_usd, kind: 'estimated_api_equivalent', source: null },
      },
      models: row.model ? [row.model] : null,
      tokenAllocation: 'known',
    },
  ]);
  const stored = db
    .prepare('SELECT claude_models_json FROM usage_snapshots WHERE session_key = ?')
    .get(key);
  assert.match(stored.claude_models_json, /GPT-6.1 Sol/);
  close();
  rmSync(dir, { recursive: true, force: true });
});

test('T28: collection log message sanitizes tokens', () => {
  const msg = sanitizeCollectionMessage('failed ghp_abc123secret tail');
  assert.ok(!msg.includes('ghp_abc123secret'));
  assert.match(msg, /<REDACTED>/);
});
