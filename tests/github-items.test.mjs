import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { EXIT_SOURCE_UNAVAILABLE } from '../dist/errors.js';
import { readProjectItems } from '../dist/github/items.js';

const dir = dirname(fileURLToPath(import.meta.url));
const pagingStub = resolve(dir, 'helpers/gh-project-items-stub.mjs');
const page1Sample = resolve(dir, 'fixtures/github/project-items-page1.json');
const page2Sample = resolve(dir, 'fixtures/github/project-items-page2.json');
const contentTypesFixture = resolve(
  dir,
  'fixtures/github/content-types-synthetic.json',
);
const PROJECT_ID = 'PVT_kwHOAGoDWs4BoZ5m';

function withPagingEnv(page1Path, page2Path, run) {
  const counter = join(tmpdir(), `gh-items-count-${Date.now()}-${Math.random()}`);
  writeFileSync(counter, '', 'utf8');
  const prevGh = process.env.ORCA_TELEMETRY_GH;
  const prevP1 = process.env.GH_STUB_PAGE1_PATH;
  const prevP2 = process.env.GH_STUB_PAGE2_PATH;
  const prevCounter = process.env.GH_STUB_COUNTER_FILE;
  process.env.ORCA_TELEMETRY_GH = pagingStub;
  process.env.GH_STUB_PAGE1_PATH = page1Path;
  process.env.GH_STUB_PAGE2_PATH = page2Path;
  process.env.GH_STUB_COUNTER_FILE = counter;
  return run(counter).finally(() => {
    if (prevGh === undefined) delete process.env.ORCA_TELEMETRY_GH;
    else process.env.ORCA_TELEMETRY_GH = prevGh;
    if (prevP1 === undefined) delete process.env.GH_STUB_PAGE1_PATH;
    else process.env.GH_STUB_PAGE1_PATH = prevP1;
    if (prevP2 === undefined) delete process.env.GH_STUB_PAGE2_PATH;
    else process.env.GH_STUB_PAGE2_PATH = prevP2;
    if (prevCounter === undefined) delete process.env.GH_STUB_COUNTER_FILE;
    else process.env.GH_STUB_COUNTER_FILE = prevCounter;
    rmSync(counter, { force: true });
  });
}

function buildFullPagingFixtures() {
  const sample1 = JSON.parse(readFileSync(page1Sample, 'utf8'));
  const sample2 = JSON.parse(readFileSync(page2Sample, 'utf8'));
  const pageInfo1 = sample1.data.node.items.pageInfo;
  const pageInfo2 = sample2.data.node.items.pageInfo;

  const template = sample1.data.node.items.nodes[0];
  const page1Nodes = [];
  for (let i = 0; i < 100; i += 1) {
    const clone = JSON.parse(JSON.stringify(template));
    clone.id = `PVTI_page1_${i}`;
    clone.content.id = `I_page1_${i}`;
    clone.content.number = 1000 + i;
    clone.content.url = `https://github.com/hangndat/orca-task-telemetry/issues/${1000 + i}`;
    page1Nodes.push(clone);
  }

  const page1 = {
    data: {
      node: {
        id: PROJECT_ID,
        items: {
          totalCount: 103,
          pageInfo: pageInfo1,
          nodes: page1Nodes,
        },
      },
    },
  };

  const page2 = {
    data: {
      node: {
        id: PROJECT_ID,
        items: {
          totalCount: 103,
          pageInfo: pageInfo2,
          nodes: sample2.data.node.items.nodes,
        },
      },
    },
  };

  const tmp = mkdtempSync(join(tmpdir(), 'gh-items-fix-'));
  const p1 = join(tmp, 'page1.json');
  const p2 = join(tmp, 'page2.json');
  writeFileSync(p1, JSON.stringify(page1));
  writeFileSync(p2, JSON.stringify(page2));
  return { tmp, p1, p2, pageInfo1 };
}

test('AC1: paginates 103 items in two GraphQL calls with page-1 cursor', async () => {
  const { tmp, p1, p2, pageInfo1 } = buildFullPagingFixtures();
  await withPagingEnv(p1, p2, async (counter) => {
    const items = await readProjectItems(PROJECT_ID, { ghPath: pagingStub });
    assert.equal(items.length, 103);
    assert.equal(items[0].itemId, 'PVTI_page1_0');
    assert.equal(items[100].itemId, sample2NodeId());
    const calls = readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(calls.length, 2);
    assert.equal(items[99].itemId, 'PVTI_page1_99');
    assert.ok(pageInfo1.endCursor.length > 0);
  });
  rmSync(tmp, { recursive: true, force: true });
});

function sample2NodeId() {
  const sample2 = JSON.parse(readFileSync(page2Sample, 'utf8'));
  return sample2.data.node.items.nodes[0].id;
}

test('AC2: maps Issue node id, repo, number, url, title, state from fixture', async () => {
  const sample1 = JSON.parse(readFileSync(page1Sample, 'utf8'));
  const singlePage = {
    data: {
      node: {
        id: PROJECT_ID,
        items: {
          totalCount: 2,
          pageInfo: { hasNextPage: false, endCursor: 'x' },
          nodes: sample1.data.node.items.nodes,
        },
      },
    },
  };
  const tmp = mkdtempSync(join(tmpdir(), 'gh-items-ac2-'));
  const p = join(tmp, 'one.json');
  writeFileSync(p, JSON.stringify(singlePage));
  await withPagingEnv(p, p, async () => {
    const items = await readProjectItems(PROJECT_ID, { ghPath: pagingStub });
    assert.equal(items.length, 2);
    const first = items[0];
    assert.equal(first.contentType, 'Issue');
    assert.equal(first.issue.issueNodeId, 'I_kwDOVUhnY88AAAABZZE2rQ');
    assert.equal(first.issue.repository.nameWithOwner, 'hangndat/orca-task-telemetry');
    assert.equal(first.issue.number, 3);
    assert.match(first.issue.url, /\/issues\/3$/);
    assert.match(first.issue.title, /E01/);
    assert.equal(first.issue.state, 'OPEN');
  });
  rmSync(tmp, { recursive: true, force: true });
});

test('AC3: classifies Issue, PullRequest, DraftIssue, and Redacted content', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gh-items-ac3-'));
  const p = join(tmp, 'types.json');
  writeFileSync(p, readFileSync(contentTypesFixture, 'utf8'));
  await withPagingEnv(p, p, async () => {
    const items = await readProjectItems('PVT_synthetic_project', {
      ghPath: pagingStub,
    });
    assert.equal(items.length, 4);
    assert.equal(items[0].contentType, 'Issue');
    assert.ok(items[0].issue);
    assert.equal(items[1].contentType, 'PullRequest');
    assert.equal(items[1].issue, null);
    assert.equal(items[2].contentType, 'DraftIssue');
    assert.equal(items[2].issue, null);
    assert.equal(items[3].contentType, 'Redacted');
    assert.equal(items[3].issue, null);
  });
  rmSync(tmp, { recursive: true, force: true });
});

test('AC4: missing Issue id → github_bad_response with field path', async () => {
  const bad = {
    data: {
      node: {
        id: PROJECT_ID,
        items: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: 'x' },
          nodes: [
            {
              id: 'PVTI_bad',
              type: 'ISSUE',
              content: {
                __typename: 'Issue',
                number: 1,
                title: 't',
                url: 'https://github.com/hangndat/orca-task-telemetry/issues/1',
                state: 'OPEN',
                repository: { nameWithOwner: 'hangndat/orca-task-telemetry' },
              },
            },
          ],
        },
      },
    },
  };
  const tmp = mkdtempSync(join(tmpdir(), 'gh-items-ac4-'));
  const p = join(tmp, 'bad.json');
  writeFileSync(p, JSON.stringify(bad));
  await withPagingEnv(p, p, async () => {
    await assert.rejects(
      () => readProjectItems(PROJECT_ID, { ghPath: pagingStub }),
      (err) => {
        assert.equal(err.code, 'github_bad_response');
        assert.equal(err.exitCode, EXIT_SOURCE_UNAVAILABLE);
        assert.match(err.message, /items\.nodes\[0\]\.content\.id/);
        return true;
      },
    );
  });
  rmSync(tmp, { recursive: true, force: true });
});

test('AC4: repeating cursor stops with github_bad_response', async () => {
  const stuck = {
    data: {
      node: {
        id: PROJECT_ID,
        items: {
          totalCount: 200,
          pageInfo: {
            hasNextPage: true,
            endCursor: 'STUCK_CURSOR',
          },
          nodes: [
            {
              id: 'PVTI_stuck',
              type: 'ISSUE',
              content: {
                __typename: 'Issue',
                id: 'I_stuck',
                number: 1,
                title: 't',
                url: 'https://github.com/hangndat/orca-task-telemetry/issues/1',
                state: 'OPEN',
                repository: { nameWithOwner: 'hangndat/orca-task-telemetry' },
              },
            },
          ],
        },
      },
    },
  };
  const tmp = mkdtempSync(join(tmpdir(), 'gh-items-stuck-'));
  const p = join(tmp, 'stuck.json');
  writeFileSync(p, JSON.stringify(stuck));
  await withPagingEnv(p, p, async () => {
    await assert.rejects(
      () => readProjectItems(PROJECT_ID, { ghPath: pagingStub, maxPages: 5 }),
      (err) => {
        assert.equal(err.code, 'github_bad_response');
        assert.match(err.message, /cursor did not advance/);
        return true;
      },
    );
  });
  rmSync(tmp, { recursive: true, force: true });
});
