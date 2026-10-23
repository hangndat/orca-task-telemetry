import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { EXIT_SOURCE_UNAVAILABLE } from '../dist/errors.js';
import { discoverProjects } from '../dist/github/projects.js';

const dir = dirname(fileURLToPath(import.meta.url));
const stub = resolve(dir, 'helpers/gh-projects-stub.mjs');
const repoUser = resolve(dir, 'fixtures/github/project-discovery-repo-user.json');
const userOwner = resolve(dir, 'fixtures/github/project-discovery-user-owner.json');
const orgRepo = resolve(dir, 'fixtures/github/project-discovery-org-repo.json');
const orgOwner = resolve(dir, 'fixtures/github/project-discovery-org-owner.json');

function withStub(env, run) {
  const prevGh = process.env.ORCA_TELEMETRY_GH;
  const keys = [
    'GH_STUB_GRAPHQL_REPO_JSON',
    'GH_STUB_GRAPHQL_OWNER_JSON',
    'GH_STUB_STDERR',
    'GH_STUB_EXIT_CODE',
  ];
  const saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  process.env.ORCA_TELEMETRY_GH = stub;
  Object.assign(process.env, env);
  return run().finally(() => {
    if (prevGh === undefined) delete process.env.ORCA_TELEMETRY_GH;
    else process.env.ORCA_TELEMETRY_GH = prevGh;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('AC1: user owner dedupes repository and owner projects, preserves closed', async () => {
  await withStub(
    {
      GH_STUB_GRAPHQL_REPO_JSON: readFileSync(repoUser, 'utf8'),
      GH_STUB_GRAPHQL_OWNER_JSON: readFileSync(userOwner, 'utf8'),
    },
    async () => {
      const projects = await discoverProjects(
        { owner: 'hangndat', name: 'orca-task-telemetry' },
        { ghPath: stub },
      );
      assert.equal(projects.length, 2);
      const dup = projects.find((p) => p.id === 'PVT_kwHOAGoDWs4BoZ5m');
      assert.ok(dup);
      assert.deepEqual(dup.sources.sort(), ['owner', 'repository']);
      assert.equal(dup.owner.kind, 'user');
      assert.equal(dup.owner.login, 'hangndat');
      const closed = projects.find((p) => p.number === 2);
      assert.equal(closed?.closed, true);
    },
  );
});

test('AC1: organization owner with empty repository list', async () => {
  await withStub(
    {
      GH_STUB_GRAPHQL_REPO_JSON: readFileSync(orgRepo, 'utf8'),
      GH_STUB_GRAPHQL_OWNER_JSON: readFileSync(orgOwner, 'utf8'),
    },
    async () => {
      const projects = await discoverProjects(
        { owner: 'acme-corp', name: 'widget' },
        { ghPath: stub },
      );
      assert.equal(projects.length, 1);
      assert.equal(projects[0].owner.kind, 'organization');
      assert.equal(projects[0].closed, true);
      assert.deepEqual(projects[0].sources, ['owner']);
    },
  );
});

test('AC1: repeating cursor on pagination → github_bad_response', async () => {
  const stuck = {
    data: {
      repository: {
        owner: { __typename: 'User', login: 'hangndat' },
        projectsV2: {
          pageInfo: { hasNextPage: true, endCursor: 'STUCK' },
          nodes: [
            {
              id: 'PVT_stuck',
              number: 1,
              title: 'One',
              url: 'https://github.com/users/hangndat/projects/1',
              closed: false,
            },
          ],
        },
      },
    },
  };
  await withStub(
    {
      GH_STUB_GRAPHQL_REPO_JSON: JSON.stringify(stuck),
      GH_STUB_GRAPHQL_OWNER_JSON: readFileSync(userOwner, 'utf8'),
    },
    async () => {
      await assert.rejects(
        () =>
          discoverProjects(
            { owner: 'hangndat', name: 'orca-task-telemetry' },
            { ghPath: stub, maxPages: 3 },
          ),
        (err) => {
          assert.equal(err.code, 'github_bad_response');
          assert.equal(err.exitCode, EXIT_SOURCE_UNAVAILABLE);
          assert.match(err.message, /cursor did not advance/);
          return true;
        },
      );
    },
  );
});
