import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { emptyConfig, loadConfig, saveConfig } from '../dist/config.js';
import {
  getProfile,
  listProfiles,
  profileNotFoundError,
  upsertProfile,
} from '../dist/profiles.js';

const REPO_A = {
  id: 'R_kgDOA',
  nameWithOwner: 'acme/alpha',
  url: 'https://github.com/acme/alpha',
};

const REPO_B = {
  id: 'R_kgDOB',
  nameWithOwner: 'acme/beta',
  url: 'https://github.com/acme/beta',
};

const PROJECT_A = {
  id: 'PVT_a',
  number: 4,
  title: 'Board A',
  url: 'https://github.com/users/acme/projects/4',
  closed: false,
  owner: { kind: 'user', login: 'acme' },
  sources: ['repository'],
};

const PROJECT_B = {
  id: 'PVT_b',
  number: 2,
  title: 'Board B',
  url: 'https://github.com/users/acme/projects/2',
  closed: false,
  owner: { kind: 'user', login: 'acme' },
  sources: ['owner'],
};

const FIXED_NOW = () => '2026-01-15T10:00:00.000Z';
const FIXED_LATER = () => '2026-01-16T12:00:00.000Z';

test('two repositories keep separate profiles by node id', () => {
  let config = emptyConfig();
  const first = upsertProfile(config, REPO_A, PROJECT_A, FIXED_NOW);
  config = first.config;
  const second = upsertProfile(config, REPO_B, PROJECT_B, FIXED_NOW);
  config = second.config;

  assert.equal(getProfile(config, REPO_A.id).project.id, 'PVT_a');
  assert.equal(getProfile(config, REPO_B.id).project.id, 'PVT_b');
  assert.equal(listProfiles(config).length, 2);
});

test('missing profile throws actionable error', () => {
  assert.throws(
    () => getProfile(emptyConfig(), 'R_missing'),
    (err) =>
      err.code === 'profile_not_found' &&
      /init/i.test(err.hint ?? ''),
  );
  assert.equal(profileNotFoundError().exitCode, 3);
});

test('idempotent upsert preserves timestamps and config reference', () => {
  let config = emptyConfig();
  const first = upsertProfile(config, REPO_A, PROJECT_A, FIXED_NOW);
  config = first.config;
  const beforeJson = JSON.stringify(config);
  const again = upsertProfile(config, REPO_A, PROJECT_A, FIXED_LATER);
  assert.equal(again.unchanged, true);
  assert.equal(again.config, config);
  assert.equal(JSON.stringify(again.config), beforeJson);
  assert.equal(again.profile.createdAt, '2026-01-15T10:00:00.000Z');
  assert.equal(again.profile.updatedAt, '2026-01-15T10:00:00.000Z');
});

test('project change preserves createdAt and updates updatedAt', () => {
  let config = emptyConfig();
  config = upsertProfile(config, REPO_A, PROJECT_A, FIXED_NOW).config;
  const updated = upsertProfile(
    config,
    REPO_A,
    { ...PROJECT_A, id: 'PVT_a2', number: 5, url: 'https://github.com/users/acme/projects/5' },
    FIXED_LATER,
  );
  assert.equal(updated.unchanged, false);
  assert.equal(updated.profile.createdAt, '2026-01-15T10:00:00.000Z');
  assert.equal(updated.profile.updatedAt, '2026-01-16T12:00:00.000Z');
});

test('malformed stored profile is rejected', () => {
  const config = {
    version: 1,
    profiles: {
      R_bad: { repository: { id: 'R_other', nameWithOwner: 'x/y', url: 'https://github.com/x/y' } },
    },
  };
  assert.throws(
    () => getProfile(config, 'R_bad'),
    (err) => err.code === 'profile_invalid',
  );
});

test('persisted profiles round-trip through config IO', () => {
  const appHome = mkdtempSync(join(tmpdir(), 'orca-profiles-home-'));
  try {
    let config = emptyConfig();
    config = upsertProfile(config, REPO_A, PROJECT_A, FIXED_NOW).config;
    saveConfig(appHome, config);
    const loaded = loadConfig(appHome);
    assert.equal(getProfile(loaded, REPO_A.id).project.number, 4);
  } finally {
    rmSync(appHome, { recursive: true, force: true });
  }
});
