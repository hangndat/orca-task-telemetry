import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { EXIT_ENVIRONMENT, EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE } from '../dist/errors.js';
import {
  parseGithubRemoteUrl,
  resolveRepository,
} from '../dist/repo.js';

const dir = dirname(fileURLToPath(import.meta.url));
const ghStub = resolve(dir, 'helpers/gh-repo-stub.mjs');
const foundationRoot = resolve(dir, '..');
const foundationMarker = join(foundationRoot, 'package.json');

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initTempRepo(remotes) {
  const root = mkdtempSync(join(tmpdir(), 'orca-repo-test-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  writeFileSync(join(root, 'README.md'), '# temp\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'init');
  for (const [name, url] of remotes) {
    git(root, 'remote', 'add', name, url);
  }
  return root;
}

function ghEnv(json, extra = {}) {
  return {
    ORCA_TELEMETRY_GH: ghStub,
    GH_STUB_REPO_VIEW_JSON: json,
    GH_STUB_EXIT_CODE: '0',
    ...extra,
  };
}

async function withGhEnv(env, run) {
  const prev = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(env)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

const canonicalGh = JSON.stringify({
  id: 'R_kgDOExample',
  nameWithOwner: 'acme/widget',
  url: 'https://github.com/acme/widget',
});

test('parseGithubRemoteUrl accepts HTTPS and SSH forms', () => {
  assert.deepEqual(parseGithubRemoteUrl('https://github.com/o/r.git'), {
    owner: 'o',
    repo: 'r',
  });
  assert.deepEqual(parseGithubRemoteUrl('git@github.com:o/r.git'), {
    owner: 'o',
    repo: 'r',
  });
  assert.deepEqual(
    parseGithubRemoteUrl('ssh://git@github.com/o/r.git'),
    { owner: 'o', repo: 'r' },
  );
  assert.equal(parseGithubRemoteUrl('https://gitlab.com/o/r.git'), null);
});

test('AC1: HTTPS remote resolves with stub gh', async () => {
  const root = initTempRepo([['origin', 'https://github.com/acme/widget.git']]);
  await withGhEnv(ghEnv(canonicalGh), async () => {
    const resolved = await resolveRepository(root, undefined, { ghPath: ghStub });
    assert.equal(resolved.remoteName, 'origin');
    assert.equal(resolved.github.id, 'R_kgDOExample');
    assert.equal(resolved.github.nameWithOwner, 'acme/widget');
    assert.match(resolved.github.url, /^https:\/\/github\.com\//);
  });
  rmSync(root, { recursive: true, force: true });
});

test('AC1: SSH remote parses and resolves', async () => {
  const root = initTempRepo([['origin', 'git@github.com:acme/widget.git']]);
  await withGhEnv(ghEnv(canonicalGh), async () => {
    const resolved = await resolveRepository(root, undefined, { ghPath: ghStub });
    assert.equal(resolved.github.nameWithOwner, 'acme/widget');
  });
  rmSync(root, { recursive: true, force: true });
});

test('AC1: no GitHub remote → no_github_remote', async () => {
  const root = initTempRepo([['origin', 'https://gitlab.com/acme/widget.git']]);
  await withGhEnv(ghEnv(canonicalGh), async () => {
    await assert.rejects(
      () => resolveRepository(root, undefined, { ghPath: ghStub }),
      (err) => {
        assert.equal(err.code, 'no_github_remote');
        assert.equal(err.exitCode, EXIT_ENVIRONMENT);
        return true;
      },
    );
  });
  rmSync(root, { recursive: true, force: true });
});

test('AC1: multiple GitHub remotes require explicit remote', async () => {
  const root = initTempRepo([
    ['origin', 'https://github.com/acme/widget.git'],
    ['upstream', 'https://github.com/acme/upstream.git'],
  ]);
  const upstreamGh = JSON.stringify({
    id: 'R_upstream',
    nameWithOwner: 'acme/upstream',
    url: 'https://github.com/acme/upstream',
  });
  await withGhEnv(ghEnv(canonicalGh), async () => {
    await assert.rejects(
      () => resolveRepository(root, undefined, { ghPath: ghStub }),
      (err) => {
        assert.equal(err.code, 'ambiguous_github_remote');
        assert.equal(err.exitCode, EXIT_USAGE);
        return true;
      },
    );
    process.env.GH_STUB_REPO_VIEW_JSON = upstreamGh;
    const resolved = await resolveRepository(root, 'upstream', { ghPath: ghStub });
    assert.equal(resolved.remoteName, 'upstream');
    assert.equal(resolved.github.nameWithOwner, 'acme/upstream');
  });
  rmSync(root, { recursive: true, force: true });
});

test('AC1: unknown remote name → unknown_git_remote', async () => {
  const root = initTempRepo([['origin', 'https://github.com/acme/widget.git']]);
  await withGhEnv(ghEnv(canonicalGh), async () => {
    await assert.rejects(
      () => resolveRepository(root, 'missing', { ghPath: ghStub }),
      (err) => {
        assert.equal(err.code, 'unknown_git_remote');
        assert.equal(err.exitCode, EXIT_USAGE);
        return true;
      },
    );
  });
  rmSync(root, { recursive: true, force: true });
});

test('AC1: not a git directory → not_a_git_repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-not-git-'));
  await withGhEnv(ghEnv(canonicalGh), async () => {
    await assert.rejects(
      () => resolveRepository(root, undefined, { ghPath: ghStub }),
      (err) => {
        assert.equal(err.code, 'not_a_git_repository');
        assert.equal(err.exitCode, EXIT_ENVIRONMENT);
        return true;
      },
    );
  });
  rmSync(root, { recursive: true, force: true });
});

test('AC2: strict gh JSON validation', async () => {
  const root = initTempRepo([['origin', 'https://github.com/acme/widget.git']]);
  await withGhEnv(
    {
      ORCA_TELEMETRY_GH: ghStub,
      GH_STUB_REPO_VIEW_JSON: '{"id":"R_x"}',
      GH_STUB_EXIT_CODE: '0',
    },
    async () => {
      await assert.rejects(
        () => resolveRepository(root, undefined, { ghPath: ghStub }),
        (err) => {
          assert.equal(err.code, 'github_repo_bad_response');
          assert.equal(err.exitCode, EXIT_SOURCE_UNAVAILABLE);
          return true;
        },
      );
    },
  );
  rmSync(root, { recursive: true, force: true });
});

test('AC1: resolution does not modify Foundation working tree marker', async () => {
  const before = hashFile(foundationMarker);
  const root = initTempRepo([['origin', 'https://github.com/acme/widget.git']]);
  await withGhEnv(ghEnv(canonicalGh), async () => {
    await resolveRepository(root, undefined, { ghPath: ghStub });
  });
  rmSync(root, { recursive: true, force: true });
  const after = hashFile(foundationMarker);
  assert.equal(before, after);
});
