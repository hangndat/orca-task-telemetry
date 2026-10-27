import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTelemetryDatabase } from '../../dist/db/index.js';
import { insertManualRoleLink, insertCollectionAttempt } from '../../dist/db/run-provenance.js';

// Synthetic/redacted fixture; no live Orca or agent-top evidence.

export function setupOverheadDb() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-overhead-'));
  const dbPath = join(dir, 'telemetry.sqlite');
  const handle = openTelemetryDatabase({ dbPath });
  return { db: handle.db, dbPath, close: () => { handle.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export function ctx(db) {
  return { db, close() {} };
}

export function insertRunGraph(db, host, run, dispatchIds) {
  db.prepare('INSERT OR IGNORE INTO orca_runs VALUES (?, ?, ?, ?)')
    .run(host, run, '2026-10-24T00:00:00.000Z', '1.4.241');
  db.prepare('INSERT OR IGNORE INTO orca_tasks (host_id, run_id, task_id) VALUES (?, ?, ?)')
    .run(host, run, 'task-1');
  for (const dispatchId of dispatchIds) {
    db.prepare(`INSERT OR IGNORE INTO orca_dispatches (host_id, run_id, task_id, dispatch_id)
      VALUES (?, ?, ?, ?)`).run(host, run, 'task-1', dispatchId);
  }
}

function tokensJsonFor(provider, overrides = {}) {
  const base = provider === 'codex'
    ? { provider: 'codex', input: 10, output: 5, cacheRead: 1, cacheWrite: 0, reasoning: null }
    : { provider: 'claude', input: 8, output: 4, cacheRead: 2, cacheWrite: 1 };
  return JSON.stringify({ ...base, ...overrides });
}

/**
 * Insert a usage session; optionally a snapshot (upsert via INSERT OR REPLACE,
 * so calling this twice for the same key simulates a re-collect without
 * double counting, matching the cumulative-snapshot upsert contract).
 */
export function insertSession(db, { key, provider, rawId, snapshot }) {
  db.prepare(`INSERT OR IGNORE INTO usage_sessions (session_key, provider, source, raw_id)
    VALUES (?, ?, 'agent-top', ?)`).run(key, provider, rawId);
  if (snapshot === undefined) return;
  const { observedAt, cost, tokensOverride } = snapshot;
  const tokensJson = tokensJsonFor(provider, tokensOverride);
  if (cost === 'unknown') {
    db.prepare(`INSERT OR REPLACE INTO usage_snapshots
      (session_key, observed_at, tokens_json, cost_amount_usd, cost_kind)
      VALUES (?, ?, ?, NULL, 'unknown')`).run(key, observedAt, tokensJson);
  } else {
    db.prepare(`INSERT OR REPLACE INTO usage_snapshots
      (session_key, observed_at, tokens_json, cost_amount_usd, cost_kind)
      VALUES (?, ?, ?, ?, 'estimated_api_equivalent')`).run(key, observedAt, tokensJson, cost);
  }
}

export function linkRole(db, { key, role, host, run, dispatch }) {
  insertManualRoleLink(db, {
    sessionKey: key, role, hostId: host, runId: run, dispatchId: dispatch ?? null,
    linkedAt: '2026-10-24T00:00:00.000Z', verifier: 'operator',
  });
}

export function attempt(db, options) {
  insertCollectionAttempt(db, options);
}

export function isoMinus(now, seconds) {
  return new Date(now.getTime() - seconds * 1000).toISOString();
}
