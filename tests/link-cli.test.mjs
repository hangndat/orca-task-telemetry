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
import { importCodeBurnUsage, openTelemetryDatabase } from '../dist/db/index.js';
import { parseCodexSessions } from '../dist/codeburn/codex.js';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(dir, '../dist/cli.js');
const ghResolveStub = resolve(dir, 'helpers/integration-stubs/gh-collect.mjs');
const codexRow = JSON.parse(
  readFileSync(
    join(dir, 'fixtures/codeburn/codex/session-gpt-small-aggregated.json'),
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
  const parsed = parseCodexSessions([codexRow], observedAt, '0.9.27')[0];
  importCodeBurnUsage(handle.db, [
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

  return { repo, appHome, env, sessionId: codexRow.sessionId };
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
