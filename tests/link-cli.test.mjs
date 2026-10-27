import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { sessionKey } from '../dist/contracts.js';
import { emptyConfig, saveConfig } from '../dist/config.js';
import { upsertProfile } from '../dist/profiles.js';
import { importUsageSnapshots, importGitHubRecords, openTelemetryDatabase } from '../dist/db/index.js';
import { parseCodexSessions } from '../dist/usage/sessions.js';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(dir, '../dist/cli.js');
const ghResolveStub = resolve(dir, 'helpers/integration-stubs/gh-collect.mjs');
const codexRow = JSON.parse(
  readFileSync(
    join(dir, 'fixtures/agent-top/codex/session-gpt-small-aggregated.json'),
    'utf8',
  ),
);

function runCli(cwd, env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function setupRepoAndSession() {
  const repo = mkdtempSync(join(tmpdir(), 'orca-link-repo-'));
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'l@test.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'l'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# l\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], {
    cwd: repo,
  });

  const appHome = mkdtempSync(join(tmpdir(), 'orca-link-home-'));
  mkdirSync(appHome, { recursive: true });
  const { config } = upsertProfile(emptyConfig(), {
    id: 'R_link',
    nameWithOwner: 'o/r',
    url: 'https://github.com/o/r',
  }, {
    id: 'PVT_x',
    number: 1,
    title: 'P',
    url: 'https://github.com/users/o/projects/1',
    closed: false,
    owner: { kind: 'user', login: 'o' },
    sources: ['repository'],
  });
  saveConfig(appHome, config);

  const dbPath = join(appHome, 'telemetry.sqlite');
  const handle = openTelemetryDatabase({ dbPath, gitRoot: repo });
  const observedAt = '2026-01-01T00:00:00.000Z';
  const parsed = parseCodexSessions([codexRow], observedAt, '0.27.1')[0];
  importUsageSnapshots(handle.db, [
    {
      session: parsed.session,
      snapshot: parsed.snapshot,
      models: parsed.metadata.models,
      tokenAllocation: 'known',
      projectHint: parsed.metadata.projectHint,
    },
  ]);
  handle.close();

  const issueFixture = JSON.stringify({
    data: {
      repository: {
        issue: {
          id: 'I_link_issue_003',
          number: 3,
          url: 'https://github.com/o/r/issues/3',
          title: 'Link me',
          state: 'OPEN',
          repository: { nameWithOwner: 'o/r' },
        },
      },
    },
  });

  const env = {
    ORCA_TELEMETRY_HOME: appHome,
    ORCA_TELEMETRY_GH: ghResolveStub,
    GH_STUB_REPO_VIEW_JSON: JSON.stringify({
      id: 'R_link',
      nameWithOwner: 'o/r',
      url: 'https://github.com/o/r',
    }),
    GH_STUB_GRAPHQL_JSON: issueFixture,
  };

  return { repo, appHome, env, sessionId: codexRow.session_id };
}

test('T34: link success and idempotent second link', () => {
  const { repo, env, sessionId } = setupRepoAndSession();
  const args = [
    'link',
    '--issue',
    'o/r#3',
    '--provider',
    'codex',
    '--session',
    sessionId,
    '--json',
  ];
  const first = runCli(repo, env, ...args);
  assert.equal(first.status, 0);
  const body = JSON.parse(first.stdout.trim());
  assert.equal(body.ok, true);
  assert.equal(body.data.outcome, 'created');
  const second = runCli(repo, env, ...args);
  assert.equal(second.status, 0);
  const body2 = JSON.parse(second.stdout.trim());
  assert.equal(body2.data.outcome, 'unchanged');
  rmSync(repo, { recursive: true, force: true });
  rmSync(env.ORCA_TELEMETRY_HOME, { recursive: true, force: true });
});

test('T34: invalid provider rejected', () => {
  const { repo, env, sessionId } = setupRepoAndSession();
  const result = runCli(
    repo,
    env,
    'link',
    '--issue',
    'o/r#3',
    '--provider',
    'openai',
    '--session',
    sessionId,
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /provider/i);
  rmSync(repo, { recursive: true, force: true });
  rmSync(env.ORCA_TELEMETRY_HOME, { recursive: true, force: true });
});

test('T34: unknown session actionable error', () => {
  const { repo, env } = setupRepoAndSession();
  const result = runCli(
    repo,
    env,
    'link',
    '--issue',
    'https://github.com/o/r/issues/3',
    '--provider',
    'codex',
    '--session',
    'missing-session-id',
    '--json',
  );
  const body = JSON.parse(result.stdout.trim());
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'attribution_session_unknown');
  assert.equal(result.status, body.error.code === 'attribution_session_unknown' ? 2 : result.status);
  rmSync(repo, { recursive: true, force: true });
  rmSync(env.ORCA_TELEMETRY_HOME, { recursive: true, force: true });
});

test('T34: CLI link conflict does not overwrite existing issue mapping', () => {
  const { repo, env, sessionId, appHome } = setupRepoAndSession();
  const first = runCli(
    repo,
    env,
    'link',
    '--issue',
    'o/r#3',
    '--provider',
    'codex',
    '--session',
    sessionId,
    '--json',
  );
  assert.equal(first.status, 0);

  const dbPath = join(appHome, 'telemetry.sqlite');
  const handle = openTelemetryDatabase({ dbPath, gitRoot: repo });
  importGitHubRecords(handle.db, {
    issues: [
      {
        issueNodeId: 'I_link_issue_004',
        repository: { nameWithOwner: 'o/r' },
        number: 4,
        url: 'https://github.com/o/r/issues/4',
        title: 'Other',
        state: 'OPEN',
      },
    ],
    memberships: [],
  });
  handle.close();

  const issue4Fixture = JSON.stringify({
    data: {
      repository: {
        issue: {
          id: 'I_link_issue_004',
          number: 4,
          url: 'https://github.com/o/r/issues/4',
          title: 'Other',
          state: 'OPEN',
          repository: { nameWithOwner: 'o/r' },
        },
      },
    },
  });
  const env2 = { ...env, GH_STUB_GRAPHQL_JSON: issue4Fixture };
  const conflict = runCli(
    repo,
    env2,
    'link',
    '--issue',
    'o/r#4',
    '--provider',
    'codex',
    '--session',
    sessionId,
    '--json',
  );
  const body = JSON.parse(conflict.stdout.trim());
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'attribution_link_conflict');
  assert.match(body.error.message, /I_link_issue_003/);

  const verify = openTelemetryDatabase({ dbPath, gitRoot: repo });
  const row = verify.db
    .prepare('SELECT issue_node_id FROM session_links WHERE session_key = ?')
    .get(sessionKey('codex', 'agent-top', sessionId));
  assert.equal(row.issue_node_id, 'I_link_issue_003');
  verify.close();

  rmSync(repo, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('T34: invalid issue URL (pull request) is actionable without DB mutation', () => {
  const { repo, env, sessionId, appHome } = setupRepoAndSession();
  const prFixture = JSON.stringify({
    data: {
      repository: {
        issue: null,
        pullRequest: { id: 'PR_kwDO', number: 10 },
      },
    },
  });
  const envPr = { ...env, GH_STUB_GRAPHQL_JSON: prFixture };
  const dbPath = join(appHome, 'telemetry.sqlite');
  const beforeLinks = openTelemetryDatabase({ dbPath, gitRoot: repo });
  const linkCountBefore = beforeLinks.db
    .prepare('SELECT COUNT(*) AS c FROM session_links')
    .get().c;
  beforeLinks.close();

  const result = runCli(
    repo,
    envPr,
    'link',
    '--issue',
    'o/r#10',
    '--provider',
    'codex',
    '--session',
    sessionId,
    '--json',
  );
  const body = JSON.parse(result.stdout.trim());
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'github_not_an_issue');

  const after = openTelemetryDatabase({ dbPath, gitRoot: repo });
  assert.equal(
    after.db.prepare('SELECT COUNT(*) AS c FROM session_links').get().c,
    linkCountBefore,
  );
  after.close();

  rmSync(repo, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});
