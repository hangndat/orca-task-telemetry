import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { sessionKey } from '../dist/contracts.js';
import { emptyConfig, saveConfig } from '../dist/config.js';
import { openTelemetryDatabase } from '../dist/db/index.js';
import { upsertProfile } from '../dist/profiles.js';
import { insertSession } from './helpers/overhead-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../dist/cli.js');
const ghStub = resolve(here, 'helpers/integration-stubs/gh-suggest.mjs');

function setupApplyFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'suggest-apply-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'suggest-apply-home-'));
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo });
  mkdirSync(home, { recursive: true });
  const { config } = upsertProfile(emptyConfig(), {
    id: 'R_suggest', nameWithOwner: 'o/r', url: 'https://github.com/o/r',
  }, {
    id: 'PVT', number: 1, title: 'P',
    url: 'https://github.com/users/o/projects/1', closed: false,
    owner: { kind: 'user', login: 'o' }, sources: ['repository'],
  });
  saveConfig(home, config);
  const handle = openTelemetryDatabase({
    dbPath: join(home, 'telemetry.sqlite'),
    gitRoot: repo,
  });
  handle.db.prepare(`INSERT INTO projects (project_id) VALUES ('PVT')`).run();
  handle.db.prepare(
    `INSERT INTO issues (issue_node_id, repository_name_with_owner, number, url, title, state, parent_issue_node_id, parent_issue_observed)
     VALUES ('I1', 'acme/app', 1, 'https://github.com/acme/app/issues/1', 'App work', 'OPEN', NULL, 1),
            ('I2', 'acme/app', 2, 'https://github.com/acme/app/issues/2', 'Other app', 'OPEN', NULL, 1),
            ('I3', 'acme/other', 3, 'https://github.com/acme/other/issues/3', 'x', 'OPEN', NULL, 1)`,
  ).run();
  for (const id of ['I1', 'I2', 'I3']) {
    handle.db.prepare(`INSERT INTO project_memberships (project_id, issue_node_id) VALUES ('PVT', ?)`).run(id);
  }
  const unique = sessionKey('claude', 'agent-top', 'unique');
  const ambig = sessionKey('claude', 'agent-top', 'ambig');
  insertSession(handle.db, {
    key: unique, provider: 'claude', rawId: 'unique',
    snapshot: { observedAt: '2026-10-27T00:00:00Z', cost: 1 },
  });
  insertSession(handle.db, {
    key: ambig, provider: 'claude', rawId: 'ambig',
    snapshot: { observedAt: '2026-10-27T00:00:00Z', cost: 1 },
  });
  handle.db.prepare(`UPDATE usage_snapshots SET claude_project_hint = 'acme/other' WHERE session_key = ?`).run(unique);
  handle.db.prepare(`UPDATE usage_snapshots SET claude_project_hint = 'app' WHERE session_key = ?`).run(ambig);
  handle.close();

  const env = {
    ...process.env,
    ORCA_TELEMETRY_HOME: home,
    ORCA_TELEMETRY_GH: ghStub,
    GH_STUB_REPO_VIEW_JSON: JSON.stringify({
      id: 'R_suggest', nameWithOwner: 'o/r', url: 'https://github.com/o/r',
    }),
  };
  return { repo, home, env, uniqueKey: unique };
}

function runApply(fx, args) {
  return spawnSync(process.execPath, [cli, 'suggest-links', ...args, '--json'], {
    cwd: fx.repo,
    encoding: 'utf8',
    env: fx.env,
  });
}

test('suggest-links apply without --yes refuses and writes nothing', () => {
  const fx = setupApplyFixture();
  try {
    const result = runApply(fx, [
      'apply', '--issue', 'acme/other#3', '--provider', 'claude', '--session', 'unique',
    ]);
    assert.equal(result.status, 2);
    const body = JSON.parse(result.stdout);
    assert.equal(body.error.code, 'suggest_apply_requires_yes');
    const db = openTelemetryDatabase({
      dbPath: join(fx.home, 'telemetry.sqlite'), gitRoot: fx.repo,
    });
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM session_links').get().n, 0);
    db.close();
  } finally {
    rmSync(fx.repo, { recursive: true, force: true });
    rmSync(fx.home, { recursive: true, force: true });
  }
});

test('suggest-links apply rejects ambiguous / not-ready pairs', () => {
  const fx = setupApplyFixture();
  try {
    const ambig = runApply(fx, [
      'apply', '--issue', 'acme/other#3', '--provider', 'claude', '--session', 'ambig', '--yes',
    ]);
    assert.equal(ambig.status, 2);
    assert.equal(JSON.parse(ambig.stdout).error.code, 'suggest_apply_not_ready');

    const wrongIssue = runApply(fx, [
      'apply', '--issue', 'acme/app#1', '--provider', 'claude', '--session', 'unique', '--yes',
    ]);
    assert.equal(wrongIssue.status, 2);
    assert.equal(JSON.parse(wrongIssue.stdout).error.code, 'suggest_apply_not_ready');

    const db = openTelemetryDatabase({
      dbPath: join(fx.home, 'telemetry.sqlite'), gitRoot: fx.repo,
    });
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM session_links').get().n, 0);
    db.close();
  } finally {
    rmSync(fx.repo, { recursive: true, force: true });
    rmSync(fx.home, { recursive: true, force: true });
  }
});

test('suggest-links apply writes ready pair, is idempotent, and does not mutate GitHub', () => {
  const fx = setupApplyFixture();
  try {
    const first = runApply(fx, [
      'apply', '--issue', 'acme/other#3', '--provider', 'claude', '--session', 'unique', '--yes',
    ]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstBody = JSON.parse(first.stdout);
    assert.equal(firstBody.data.kind, 'suggest_links_apply');
    assert.equal(firstBody.data.outcome, 'created');
    assert.equal(firstBody.data.issueNodeId, 'I3');
    assert.equal(firstBody.data.linked, true);

    const second = runApply(fx, [
      'apply', '--issue', 'acme/other#3', '--provider', 'claude', '--session', 'unique', '--yes',
    ]);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(JSON.parse(second.stdout).data.outcome, 'unchanged');

    const db = openTelemetryDatabase({
      dbPath: join(fx.home, 'telemetry.sqlite'), gitRoot: fx.repo,
    });
    const links = db.db.prepare('SELECT session_key, issue_node_id, method FROM session_links').all();
    assert.equal(links.length, 1);
    assert.equal(links[0].session_key, fx.uniqueKey);
    assert.equal(links[0].issue_node_id, 'I3');
    assert.equal(links[0].method, 'manual');
    db.close();
  } finally {
    rmSync(fx.repo, { recursive: true, force: true });
    rmSync(fx.home, { recursive: true, force: true });
  }
});
