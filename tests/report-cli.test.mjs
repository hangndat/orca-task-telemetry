import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { openTelemetryDatabase } from '../dist/db/index.js';
import {
  initBareRepo,
  installDatasetInHome,
  linkAlphaSessions,
  runCliReport,
  snapshotDbCounts,
  writeReportsProfile,
} from './helpers/reports-harness.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const ghStub = resolve(testDir, 'helpers/gh-repo-stub.mjs');

function reportEnv(appHome) {
  return {
    ORCA_TELEMETRY_HOME: appHome,
    ORCA_TELEMETRY_GH: ghStub,
    GH_STUB_REPO_VIEW_JSON: JSON.stringify({
      id: 'R_reports',
      nameWithOwner: 'org-a/repo',
      url: 'https://github.com/org-a/repo',
    }),
  };
}

function parseJsonStdout(result) {
  return JSON.parse(result.stdout.trim());
}

test('report tasks --json via CLI (read-only DB)', () => {
  const repo = initBareRepo();
  const appHome = mkdtempSync(join(tmpdir(), 'orca-report-home-'));
  writeReportsProfile(appHome);
  const { beforeCounts } = installDatasetInHome(appHome, linkAlphaSessions);
  const result = runCliReport(['report', 'tasks', '--json'], {
    cwd: repo,
    env: reportEnv(appHome),
  });
  if (result.status !== 0) {
    throw new Error(`exit ${result.status}: ${result.stderr || result.stdout}`);
  }
  const body = parseJsonStdout(result);
  assert.equal(body.ok, true);
  assert.equal(body.data.kind, 'tasks');
  assert.ok(Array.isArray(body.data.issues));
  const handle = openTelemetryDatabase({
    dbPath: join(appHome, 'telemetry.sqlite'),
    gitRoot: repo,
  });
  assert.deepEqual(snapshotDbCounts(handle.db), beforeCounts);
  handle.close();
  rmSync(appHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test('report unmapped text includes safe link suggestion', () => {
  const repo = initBareRepo();
  const appHome = mkdtempSync(join(tmpdir(), 'orca-report-home-'));
  writeReportsProfile(appHome);
  installDatasetInHome(appHome, linkAlphaSessions);
  const result = runCliReport(['report', 'unmapped'], {
    cwd: repo,
    env: reportEnv(appHome),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Suggested link commands/);
  assert.match(result.stdout, /<issue-url-or-owner\/repo#n>/);
  rmSync(appHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});
