import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parseProjectUrl } from '../dist/commands/init.js';
import { loadConfig } from '../dist/config.js';
import { getProfile } from '../dist/profiles.js';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(dir, '../dist/cli.js');
const ghStub = resolve(dir, 'helpers/gh-projects-stub.mjs');
const repoFixture = resolve(
  dir,
  'fixtures/github/project-discovery-repo-user.json',
);
const ownerFixture = resolve(
  dir,
  'fixtures/github/project-discovery-user-owner.json',
);

function initTempRepo(remotes) {
  const root = mkdtempSync(join(tmpdir(), 'orca-init-git-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'init-test@example.com'], {
    cwd: root,
  });
  execFileSync('git', ['config', 'user.name', 'init-test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# temp\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
  for (const [name, url] of remotes) {
    execFileSync('git', ['remote', 'add', name, url], { cwd: root });
  }
  return root;
}

function captureGitRepoInventory(cwd) {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
  }).trimEnd();
  const untracked = execFileSync(
    'git',
    ['ls-files', '-o', '--exclude-standard'],
    { cwd, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .sort();
  return { status, untracked };
}

function runInitInRepo(cwd, appHome, extraEnv, ...args) {
  return spawnSync(process.execPath, [cli, 'init', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCA_TELEMETRY_HOME: appHome,
      ORCA_TELEMETRY_GH: ghStub,
      ...extraEnv,
    },
  });
}

function stubEnvForHangndat() {
  return {
    GH_STUB_REPO_VIEW_JSON: JSON.stringify({
      id: 'R_kgDOVUhnYw',
      nameWithOwner: 'hangndat/orca-task-telemetry',
      url: 'https://github.com/hangndat/orca-task-telemetry',
    }),
    GH_STUB_GRAPHQL_REPO_JSON: readFileSync(repoFixture, 'utf8'),
    GH_STUB_GRAPHQL_OWNER_JSON: readFileSync(ownerFixture, 'utf8'),
  };
}

test('parseProjectUrl accepts users and orgs paths', () => {
  assert.deepEqual(parseProjectUrl('https://github.com/users/hangndat/projects/4'), {
    kind: 'user',
    login: 'hangndat',
    number: 4,
  });
  assert.deepEqual(parseProjectUrl('https://github.com/orgs/acme/projects/2'), {
    kind: 'organization',
    login: 'acme',
    number: 2,
  });
});

test('init --project saves profile without modifying target git repo', () => {
  const gitRoot = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const appHome = mkdtempSync(join(tmpdir(), 'orca-init-home-'));
  const before = captureGitRepoInventory(gitRoot);
  const result = runInitInRepo(
    gitRoot,
    appHome,
    stubEnvForHangndat(),
    '--project',
    '4',
    '--json',
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const body = JSON.parse(result.stdout.trim());
  assert.equal(body.ok, true);
  assert.equal(body.data.profile.project.number, 4);
  const after = captureGitRepoInventory(gitRoot);
  assert.deepEqual(before, after);

  const config = loadConfig(appHome);
  assert.equal(getProfile(config, 'R_kgDOVUhnYw').project.id, 'PVT_kwHOAGoDWs4BoZ5m');

  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('repeated init with same project is idempotent on disk', () => {
  const gitRoot = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const appHome = mkdtempSync(join(tmpdir(), 'orca-init-home-'));
  const env = stubEnvForHangndat();
  const first = runInitInRepo(gitRoot, appHome, env, '--project', '4', '--json');
  assert.equal(first.status, 0);
  const configBytes = readFileSync(join(appHome, 'config.json'), 'utf8');

  const second = runInitInRepo(gitRoot, appHome, env, '--project', '4', '--json');
  assert.equal(second.status, 0);
  const body = JSON.parse(second.stdout.trim());
  assert.equal(body.data.unchanged, true);
  assert.equal(readFileSync(join(appHome, 'config.json'), 'utf8'), configBytes);

  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('init with invalid project leaves config unchanged', () => {
  const gitRoot = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const appHome = mkdtempSync(join(tmpdir(), 'orca-init-home-'));
  writeFileSync(
    join(appHome, 'config.json'),
    `${JSON.stringify({ version: 1, profiles: {} }, null, 2)}\n`,
  );
  const result = runInitInRepo(
    gitRoot,
    appHome,
    stubEnvForHangndat(),
    '--project',
    '999',
    '--json',
  );
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stdout.trim());
  assert.equal(body.ok, false);
  assert.equal(readFileSync(join(appHome, 'config.json'), 'utf8').includes('"profiles": {}'), true);

  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('init --json without --project fails on non-TTY', () => {
  const gitRoot = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const appHome = mkdtempSync(join(tmpdir(), 'orca-init-home-'));
  const result = runInitInRepo(gitRoot, appHome, stubEnvForHangndat(), '--json');
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stdout.trim());
  assert.equal(body.error.code, 'usage_error');
  assert.match(body.error.message, /--project/i);

  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('init with project URL matches discovered project', () => {
  const gitRoot = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const appHome = mkdtempSync(join(tmpdir(), 'orca-init-home-'));
  const url = 'https://github.com/users/hangndat/projects/4';
  const result = runInitInRepo(
    gitRoot,
    appHome,
    stubEnvForHangndat(),
    '--project',
    url,
    '--json',
  );
  assert.equal(result.status, 0);
  const body = JSON.parse(result.stdout.trim());
  assert.equal(body.data.profile.project.url, url);

  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('init empty projects surfaces actionable error', () => {
  const gitRoot = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const appHome = mkdtempSync(join(tmpdir(), 'orca-init-home-'));
  const emptyRepo = JSON.stringify({
    data: {
      repository: {
        owner: { __typename: 'User', login: 'hangndat' },
        projectsV2: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  });
  const emptyUser = JSON.stringify({
    data: {
      user: {
        projectsV2: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  });
  const result = runInitInRepo(
    gitRoot,
    appHome,
    {
      ...stubEnvForHangndat(),
      GH_STUB_GRAPHQL_REPO_JSON: emptyRepo,
      GH_STUB_GRAPHQL_OWNER_JSON: emptyUser,
    },
    '--project',
    '1',
    '--json',
  );
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stdout.trim());
  assert.match(body.error.message, /No GitHub Projects/i);

  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});

test('rejects ORCA_TELEMETRY_HOME inside target git repository', () => {
  const gitRoot = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const insideHome = join(gitRoot, '.orca-telemetry-home');
  const result = runInitInRepo(
    gitRoot,
    insideHome,
    stubEnvForHangndat(),
    '--project',
    '4',
    '--json',
  );
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stdout.trim());
  assert.match(body.error.message, /ORCA_TELEMETRY_HOME/i);
  assert.equal(existsSync(join(insideHome, 'config.json')), false);
  assert.equal(existsSync(join(gitRoot, 'config.json')), false);

  rmSync(gitRoot, { recursive: true, force: true });
});

test('ambiguous project number requires full URL', () => {
  const gitRoot = initTempRepo([
    ['origin', 'https://github.com/hangndat/orca-task-telemetry.git'],
  ]);
  const appHome = mkdtempSync(join(tmpdir(), 'orca-init-home-'));
  const dupNumberRepo = JSON.stringify({
    data: {
      repository: {
        owner: { __typename: 'User', login: 'hangndat' },
        projectsV2: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'PVT_one',
              number: 7,
              title: 'One',
              url: 'https://github.com/users/hangndat/projects/7',
              closed: false,
            },
          ],
        },
      },
    },
  });
  const dupNumberUser = JSON.stringify({
    data: {
      user: {
        projectsV2: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'PVT_two',
              number: 7,
              title: 'Two',
              url: 'https://github.com/users/hangndat/projects/7',
              closed: false,
            },
          ],
        },
      },
    },
  });
  const result = runInitInRepo(
    gitRoot,
    appHome,
    {
      ...stubEnvForHangndat(),
      GH_STUB_GRAPHQL_REPO_JSON: dupNumberRepo,
      GH_STUB_GRAPHQL_OWNER_JSON: dupNumberUser,
    },
    '--project',
    '7',
    '--json',
  );
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stdout.trim());
  assert.match(body.error.message, /ambiguous/i);

  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(appHome, { recursive: true, force: true });
});
