import assert from 'node:assert/strict';
import { test } from 'vitest';
import { sessionKey } from '../dist/contracts.js';
import { suggestSessionLinks } from '../dist/attribution/suggest.js';
import { buildRetriesReport } from '../dist/reports/retries.js';
import { buildDuplicatesReport } from '../dist/reports/duplicates.js';
import { buildWasteReport, OVERSIZE_CONTEXT_TOKENS } from '../dist/reports/waste.js';
import { buildBudgetReport } from '../dist/reports/budget.js';
import {
  setupOverheadDb,
  ctx,
  insertRunGraph,
  insertSession,
  linkRole,
} from './helpers/overhead-harness.mjs';

test('V1.5 report retries sums known worker cost on retry nodes', () => {
  const h = setupOverheadDb();
  try {
    insertRunGraph(h.db, 'host-a', 'run-1', ['d1', 'd2']);
    h.db.prepare(`UPDATE orca_dispatches SET retry_of_dispatch_id = 'd1'
      WHERE host_id = 'host-a' AND run_id = 'run-1' AND dispatch_id = 'd2'`).run();
    insertSession(h.db, {
      key: 'claude:agent-top:s-root', provider: 'claude', rawId: 's-root',
      snapshot: { observedAt: '2026-10-27T00:00:00Z', cost: 1 },
    });
    insertSession(h.db, {
      key: 'claude:agent-top:s-retry', provider: 'claude', rawId: 's-retry',
      snapshot: { observedAt: '2026-10-27T00:00:00Z', cost: 4 },
    });
    linkRole(h.db, { key: 'claude:agent-top:s-root', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'd1' });
    linkRole(h.db, { key: 'claude:agent-top:s-retry', role: 'worker', host: 'host-a', run: 'run-1', dispatch: 'd2' });

    const report = buildRetriesReport(ctx(h.db), 'host-a', 'run-1');
    assert.equal(report.totals.chainCount, 1);
    assert.equal(report.totals.retryDispatchCount, 1);
    assert.equal(report.totals.wastedRetryKnownCostUsd, 4);
  } finally {
    h.close();
  }
});

test('V1.6 duplicates ignores pure retry chains but flags parallel dispatches', () => {
  const h = setupOverheadDb();
  try {
    insertRunGraph(h.db, 'host-a', 'run-1', ['d1', 'd2']);
    h.db.prepare(`UPDATE orca_dispatches SET retry_of_dispatch_id = 'd1'
      WHERE host_id = 'host-a' AND run_id = 'run-1' AND dispatch_id = 'd2'`).run();
    assert.equal(buildDuplicatesReport(ctx(h.db), 'host-a', 'run-1').groups.length, 0);

    h.db.prepare(
      `INSERT INTO orca_dispatches (host_id, run_id, task_id, dispatch_id)
       VALUES ('host-a', 'run-1', 'task-1', 'd3')`,
    ).run();
    const report = buildDuplicatesReport(ctx(h.db), 'host-a', 'run-1');
    assert.equal(report.groups.length, 1);
    assert.deepEqual(report.groups[0].dispatchIds.sort(), ['d1', 'd2', 'd3']);
  } finally {
    h.close();
  }
});

test('V1.7 waste flags cache miss and oversize context', () => {
  const h = setupOverheadDb();
  try {
    h.db.prepare(`INSERT INTO projects (project_id) VALUES ('PVT')`).run();
    h.db.prepare(
      `INSERT INTO issues (issue_node_id, repository_name_with_owner, number, url, title, state, parent_issue_node_id, parent_issue_observed)
       VALUES ('I1', 'o/r', 1, 'https://github.com/o/r/issues/1', 't', 'OPEN', NULL, 1)`,
    ).run();
    h.db.prepare(`INSERT INTO project_memberships (project_id, issue_node_id) VALUES ('PVT', 'I1')`).run();

    const missKey = sessionKey('claude', 'agent-top', 's-miss');
    const bigKey = sessionKey('claude', 'agent-top', 's-big');
    insertSession(h.db, {
      key: missKey, provider: 'claude', rawId: 's-miss',
      snapshot: {
        observedAt: '2026-10-27T00:00:00Z', cost: 2,
        tokensOverride: { input: 1000, cacheRead: 10, output: 1, cacheWrite: 0 },
      },
    });
    insertSession(h.db, {
      key: bigKey, provider: 'claude', rawId: 's-big',
      snapshot: {
        observedAt: '2026-10-27T00:00:00Z', cost: 9,
        tokensOverride: {
          input: OVERSIZE_CONTEXT_TOKENS,
          cacheRead: OVERSIZE_CONTEXT_TOKENS,
          output: 1,
          cacheWrite: 0,
        },
      },
    });
    h.db.prepare(
      `INSERT INTO session_links (session_key, issue_node_id, method, linked_at)
       VALUES (?, 'I1', 'manual', '2026-10-27T00:00:00Z')`,
    ).run(missKey);
    h.db.prepare(
      `INSERT INTO session_links (session_key, issue_node_id, method, linked_at)
       VALUES (?, 'I1', 'manual', '2026-10-27T00:00:00Z')`,
    ).run(bigKey);

    const report = buildWasteReport({
      profile: {
        repository: { id: 'R', nameWithOwner: 'o/r', url: 'u' },
        project: { id: 'PVT', number: 1, url: 'u', owner: { kind: 'user', login: 'o' } },
        createdAt: 't',
        updatedAt: 't',
      },
      db: h.db,
      close() {},
    });
    assert.equal(report.totals.findingCount, 2);
    assert.equal(report.totals.cacheMissCount, 1);
    assert.equal(report.totals.oversizeCount, 1);
  } finally {
    h.close();
  }
});

test('V1.8 budget marks Issues over --limit-usd', () => {
  const h = setupOverheadDb();
  try {
    h.db.prepare(`INSERT INTO projects (project_id) VALUES ('PVT')`).run();
    h.db.prepare(
      `INSERT INTO issues (issue_node_id, repository_name_with_owner, number, url, title, state, parent_issue_node_id, parent_issue_observed)
       VALUES ('I1', 'o/r', 1, 'https://github.com/o/r/issues/1', 't', 'OPEN', NULL, 1)`,
    ).run();
    h.db.prepare(`INSERT INTO project_memberships (project_id, issue_node_id) VALUES ('PVT', 'I1')`).run();
    const key = sessionKey('claude', 'agent-top', 's1');
    insertSession(h.db, {
      key, provider: 'claude', rawId: 's1',
      snapshot: { observedAt: '2026-10-27T00:00:00Z', cost: 12 },
    });
    h.db.prepare(
      `INSERT INTO session_links (session_key, issue_node_id, method, linked_at)
       VALUES (?, 'I1', 'manual', '2026-10-27T00:00:00Z')`,
    ).run(key);

    const report = buildBudgetReport({
      profile: {
        repository: { id: 'R', nameWithOwner: 'o/r', url: 'u' },
        project: { id: 'PVT', number: 1, url: 'u', owner: { kind: 'user', login: 'o' } },
        createdAt: 't',
        updatedAt: 't',
      },
      db: h.db,
      close() {},
    }, { limitUsd: 5, rollup: 'direct' });
    assert.equal(report.totals.overCount, 1);
    assert.equal(report.warnings[0].status, 'over');
    assert.ok(report.warnings[0].overByUsd >= 7);
  } finally {
    h.close();
  }
});

test('V1.9 suggest-links marks unique hint ready and multi-match needs_approval', () => {
  const h = setupOverheadDb();
  try {
    h.db.prepare(`INSERT INTO projects (project_id) VALUES ('PVT')`).run();
    h.db.prepare(
      `INSERT INTO issues (issue_node_id, repository_name_with_owner, number, url, title, state, parent_issue_node_id, parent_issue_observed)
       VALUES ('I1', 'acme/app', 1, 'https://github.com/acme/app/issues/1', 'App work', 'OPEN', NULL, 1),
              ('I2', 'acme/app', 2, 'https://github.com/acme/app/issues/2', 'Other app', 'OPEN', NULL, 1),
              ('I3', 'acme/other', 3, 'https://github.com/acme/other/issues/3', 'x', 'OPEN', NULL, 1)`,
    ).run();
    for (const id of ['I1', 'I2', 'I3']) {
      h.db.prepare(`INSERT INTO project_memberships (project_id, issue_node_id) VALUES ('PVT', ?)`).run(id);
    }
    const unique = sessionKey('claude', 'agent-top', 'unique');
    const ambig = sessionKey('claude', 'agent-top', 'ambig');
    insertSession(h.db, {
      key: unique, provider: 'claude', rawId: 'unique',
      snapshot: { observedAt: '2026-10-27T00:00:00Z', cost: 1 },
    });
    insertSession(h.db, {
      key: ambig, provider: 'claude', rawId: 'ambig',
      snapshot: { observedAt: '2026-10-27T00:00:00Z', cost: 1 },
    });
    h.db.prepare(`UPDATE usage_snapshots SET claude_project_hint = 'acme/other' WHERE session_key = ?`).run(unique);
    h.db.prepare(`UPDATE usage_snapshots SET claude_project_hint = 'app' WHERE session_key = ?`).run(ambig);

    const suggestions = suggestSessionLinks(h.db, 'PVT');
    const u = suggestions.find((s) => s.rawSessionId === 'unique');
    const a = suggestions.find((s) => s.rawSessionId === 'ambig');
    assert.equal(u.status, 'ready');
    assert.deepEqual(u.candidateIssueNodeIds, ['I3']);
    assert.equal(a.status, 'needs_approval');
    assert.ok(a.candidateIssueNodeIds.length >= 2);
  } finally {
    h.close();
  }
});
