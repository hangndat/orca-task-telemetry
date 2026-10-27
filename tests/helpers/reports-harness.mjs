import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkSessionToIssue } from '../../dist/attribution/link.js';
import { sessionKey } from '../../dist/contracts.js';
import { emptyConfig, saveConfig } from '../../dist/config.js';
import {
  importUsageSnapshots,
  importGitHubRecords,
  openTelemetryDatabase,
} from '../../dist/db/index.js';
import { upsertProfile } from '../../dist/profiles.js';
import { disposeDataset, loadSyntheticDataset } from './attribution-dataset.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(dir, '../fixtures/reports/synthetic-dataset.json'), 'utf8'),
);

const LINKED_AT = '2026-06-01T10:00:00.000Z';
const FIXTURE_COLLECTION_TIME = '2026-01-01T00:00:00.000Z';

export function seedDeterministicCollectionLogs(db) {
  db.exec('DELETE FROM collection_logs');
  for (const source of ['agent-top', 'github', 'orca']) {
    db.prepare(
      `INSERT INTO collection_logs (source, status, message, recorded_at)
       VALUES (?, 'success', 'fixture import', ?)`,
    ).run(source, FIXTURE_COLLECTION_TIME);
  }
}

export function initBareRepo() {
  const root = mkdtempSync(join(tmpdir(), 'orca-report-repo-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'r@test.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'r'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# r\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/org-a/repo.git'], {
    cwd: root,
  });
  return root;
}

export function writeReportsProfile(appHome, projectId = fixture.projectId) {
  mkdirSync(appHome, { recursive: true });
  let config = emptyConfig();
  const { config: next } = upsertProfile(
    config,
    {
      id: 'R_reports',
      nameWithOwner: 'org-a/repo',
      url: 'https://github.com/org-a/repo',
    },
    {
      id: projectId,
      number: 1,
      title: 'Synthetic',
      url: 'https://github.com/users/org-a/projects/1',
      closed: false,
      owner: { kind: 'organization', login: 'org-a' },
      sources: ['repository'],
    },
  );
  saveConfig(appHome, next);
}

export function installDatasetInHome(appHome, linkFn, datasetFixture = fixture) {
  mkdirSync(appHome, { recursive: true });
  const dest = join(appHome, 'telemetry.sqlite');
  const handle = openTelemetryDatabase({ dbPath: dest });
  importGitHubRecords(handle.db, {
    issues: datasetFixture.issues,
    memberships: datasetFixture.memberships,
  });
  const rows = datasetFixture.sessions.map((s) => {
    const key = sessionKey(s.provider, 'agent-top', s.rawId);
    return {
      session: {
        sessionKey: key,
        provider: s.provider,
        source: 'agent-top',
        rawId: s.rawId,
      },
      snapshot: {
        sessionKey: key,
        observedAt: s.observedAt,
        tokens: s.tokens,
        cost: s.cost,
      },
      claudeModels: s.claudeModels ?? null,
      claudeTokenAllocation: s.claudeTokenAllocation ?? null,
      claudeProjectHint: s.claudeProjectHint ?? null,
    };
  });
  importUsageSnapshots(handle.db, rows);
  seedDeterministicCollectionLogs(handle.db);
  const ctx = { db: handle.db, dir: appHome, path: dest, close: () => handle.close() };
  if (linkFn) {
    linkFn(ctx);
  }
  const before = snapshotDbCounts(handle.db);
  handle.close();
  return { beforeCounts: before, dest };
}

export function linkAlphaSessions(ctx) {
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'agent-top',
    rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee01',
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'agent-top',
    rawSessionId: 'aaaaaaaa-claude-4ccc-8ddd-eeeeeeeeee02',
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
  linkSessionToIssue(ctx.db, {
    provider: 'codex',
    source: 'agent-top',
    rawSessionId: fixture.sharedRawSessionId,
    issueNodeId: 'I_attr_issue_alpha',
    linkedAt: LINKED_AT,
  });
}

export function linkBetaClaudeShared(ctx) {
  linkSessionToIssue(ctx.db, {
    provider: 'claude',
    source: 'agent-top',
    rawSessionId: fixture.sharedRawSessionId,
    issueNodeId: 'I_attr_issue_beta',
    linkedAt: LINKED_AT,
  });
}

export function loadReportsDataset(datasetFixture = fixture) {
  const ctx = loadSyntheticDataset(datasetFixture);
  seedDeterministicCollectionLogs(ctx.db);
  return ctx;
}

export function listAppHomeFiles(appHome) {
  if (!existsSync(appHome)) {
    return [];
  }
  return readdirSync(appHome).sort();
}

export function assertNoWalShmSidecars(appHome) {
  const names = listAppHomeFiles(appHome);
  assert.ok(!names.some((n) => n.endsWith('-wal') || n.endsWith('-shm')));
}

export function sha256File(path) {
  const data = readFileSync(path);
  return createHash('sha256').update(data).digest('hex');
}

export function appHomeInventory(appHome) {
  const files = listAppHomeFiles(appHome);
  const inventory = {};
  for (const name of files) {
    inventory[name] = sha256File(join(appHome, name));
  }
  return inventory;
}

export function snapshotDbCounts(db) {
  const tables = [
    'issues',
    'usage_sessions',
    'usage_snapshots',
    'session_links',
    'project_memberships',
  ];
  const counts = {};
  for (const table of tables) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  }
  return counts;
}

export function runCliReport(args, { cwd, env }) {
  const cli = resolve(dir, '../../dist/cli.js');
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

export { fixture, disposeDataset };
