import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  EXIT_SOURCE_UNAVAILABLE,
  EXIT_USAGE,
} from '../dist/errors.js';
import {
  PROJECT_FIELDS_QUERY,
  PROJECT_ITEM_FIELD_VALUES_QUERY,
  readProjectFields,
  readProjectItemNumberFieldValue,
  selectNumberFieldById,
  selectNumberFieldByName,
} from '../dist/github/fields.js';
import { graphql } from '../dist/github/client.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fieldsPagingStub = resolve(dir, 'helpers/gh-project-fields-stub.mjs');
const valuesPagingStub = resolve(dir, 'helpers/gh-project-item-field-values-stub.mjs');
const ghStub = resolve(dir, 'helpers/gh-stub.mjs');
const fieldsPage1 = resolve(dir, 'fixtures/github/project-fields-page1.json');
const fieldsPage2 = resolve(dir, 'fixtures/github/project-fields-page2.json');
const fieldsDup = resolve(dir, 'fixtures/github/project-fields-duplicate-name.json');
const valuesPage1 = resolve(dir, 'fixtures/github/project-item-field-values-page1.json');
const valuesPage2 = resolve(dir, 'fixtures/github/project-item-field-values-page2.json');
const valuesAbsent = resolve(dir, 'fixtures/github/project-item-field-values-absent.json');
const valuesZero = resolve(dir, 'fixtures/github/project-item-field-values-zero.json');
const valuesWrongType = resolve(dir, 'fixtures/github/project-item-field-values-wrong-type.json');
const PROJECT_ID = 'PVT_kwHOAGoDWs4BoZ5m';
const NUMBER_FIELD_ID = 'PVTF_lAHOBqA1Ws4Bom2ZzgKEstCost';

function withPagingEnv(stubPath, page1Path, page2Path, run) {
  const counter = join(tmpdir(), `gh-fields-count-${Date.now()}-${Math.random()}`);
  writeFileSync(counter, '', 'utf8');
  const prevGh = process.env.ORCA_TELEMETRY_GH;
  const prevP1 = process.env.GH_STUB_PAGE1_PATH;
  const prevP2 = process.env.GH_STUB_PAGE2_PATH;
  const prevCounter = process.env.GH_STUB_COUNTER_FILE;
  process.env.ORCA_TELEMETRY_GH = stubPath;
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

async function withGhStdout(stdout, run) {
  const prevGh = process.env.ORCA_TELEMETRY_GH;
  const prevStdout = process.env.GH_STUB_STDOUT;
  process.env.ORCA_TELEMETRY_GH = ghStub;
  process.env.GH_STUB_STDOUT = stdout;
  try {
    return await run();
  } finally {
    if (prevGh === undefined) delete process.env.ORCA_TELEMETRY_GH;
    else process.env.ORCA_TELEMETRY_GH = prevGh;
    if (prevStdout === undefined) delete process.env.GH_STUB_STDOUT;
    else process.env.GH_STUB_STDOUT = prevStdout;
  }
}

function expectCliError(promise, { code, exitCode }) {
  return promise.then(
    () => assert.fail('expected CliError'),
    (err) => {
      assert.equal(err.code, code);
      assert.equal(err.exitCode, exitCode);
      return err;
    },
  );
}

test('AC1: paginates project fields across two GraphQL pages', async () => {
  await withPagingEnv(fieldsPagingStub, fieldsPage1, fieldsPage2, async (counter) => {
    const fields = await readProjectFields(PROJECT_ID, { ghPath: fieldsPagingStub });
    assert.equal(fields.length, 3);
    assert.deepEqual(
      fields.map((f) => f.name),
      ['Status', 'Estimated cost', 'Wave'],
    );
    const calls = readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(calls.length, 2);
  });
});

test('AC1: selectNumberFieldByName resolves unique NUMBER field', async () => {
  const fields = [
    { id: 'a', name: 'Status', dataType: 'SINGLE_SELECT' },
    { id: 'b', name: 'Estimated cost', dataType: 'NUMBER' },
  ];
  const selected = selectNumberFieldByName(fields, 'Estimated cost');
  assert.equal(selected.id, 'b');
  assert.equal(selected.dataType, 'NUMBER');
});

test('AC1: duplicate field name → usage_error exit 2', async () => {
  await withGhStdout(readFileSync(fieldsDup, 'utf8'), async () => {
    const fields = await readProjectFields(PROJECT_ID, { ghPath: ghStub });
    await expectCliError(
      Promise.resolve().then(() => selectNumberFieldByName(fields, 'Budget')),
      { code: 'usage_error', exitCode: EXIT_USAGE },
    );
  });
});

test('AC1: non-NUMBER field selection → usage_error', () => {
  const fields = [{ id: 'x', name: 'Status', dataType: 'SINGLE_SELECT' }];
  expectCliError(
    Promise.resolve().then(() => selectNumberFieldByName(fields, 'Status')),
    { code: 'usage_error', exitCode: EXIT_USAGE },
  );
});

test('AC1: selectNumberFieldById rejects unknown id', () => {
  const fields = [{ id: 'b', name: 'Estimated cost', dataType: 'NUMBER' }];
  expectCliError(
    Promise.resolve().then(() => selectNumberFieldById(fields, 'missing')),
    { code: 'usage_error', exitCode: EXIT_USAGE },
  );
});

test('AC1: malformed field node missing dataType → github_bad_response', async () => {
  const stdout = JSON.stringify({
    data: {
      node: {
        id: PROJECT_ID,
        fields: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: 'PVTF_x', name: 'Broken' }],
        },
      },
    },
  });
  await withGhStdout(stdout, async () => {
    await expectCliError(readProjectFields(PROJECT_ID, { ghPath: ghStub }), {
      code: 'github_bad_response',
      exitCode: EXIT_SOURCE_UNAVAILABLE,
    });
  });
});

test('AC2: paginates fieldValues and reads NUMBER on second page', async () => {
  await withPagingEnv(valuesPagingStub, valuesPage1, valuesPage2, async (counter) => {
    const value = await readProjectItemNumberFieldValue(
      'PVTI_test_item_1',
      NUMBER_FIELD_ID,
      { ghPath: valuesPagingStub },
    );
    assert.equal(value, 42.5);
    const calls = readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(calls.length, 2);
  });
});

test('AC2: absent NUMBER value returns null after full pagination', async () => {
  await withGhStdout(readFileSync(valuesAbsent, 'utf8'), async () => {
    const value = await readProjectItemNumberFieldValue(
      'PVTI_absent',
      NUMBER_FIELD_ID,
      { ghPath: ghStub },
    );
    assert.equal(value, null);
  });
});

test('AC2: zero NUMBER value is present (not absent)', async () => {
  await withGhStdout(readFileSync(valuesZero, 'utf8'), async () => {
    const value = await readProjectItemNumberFieldValue(
      'PVTI_zero',
      'PVTF_number_target',
      { ghPath: ghStub },
    );
    assert.equal(value, 0);
  });
});

test('AC2: matching field id with non-number typename fails closed', async () => {
  await withGhStdout(readFileSync(valuesWrongType, 'utf8'), async () => {
    await expectCliError(
      readProjectItemNumberFieldValue('PVTI_wrong', 'PVTF_number_target', {
        ghPath: ghStub,
      }),
      { code: 'github_bad_response', exitCode: EXIT_SOURCE_UNAVAILABLE },
    );
  });
});

test('AC2: redacted field (null) on value node → github_bad_response', async () => {
  const stdout = JSON.stringify({
    data: {
      node: {
        id: 'PVTI_redacted',
        fieldValues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              __typename: 'ProjectV2ItemFieldNumberValue',
              number: 1,
              field: null,
            },
          ],
        },
      },
    },
  });
  await withGhStdout(stdout, async () => {
    await expectCliError(
      readProjectItemNumberFieldValue('PVTI_redacted', NUMBER_FIELD_ID, {
        ghPath: ghStub,
      }),
      { code: 'github_bad_response', exitCode: EXIT_SOURCE_UNAVAILABLE },
    );
  });
});

test('AC3: GraphQL errors surface as github_bad_response', async () => {
  const stdout = JSON.stringify({
    errors: [{ message: 'Something went wrong' }],
  });
  await withGhStdout(stdout, async () => {
    await expectCliError(readProjectFields(PROJECT_ID, { ghPath: ghStub }), {
      code: 'github_bad_response',
      exitCode: EXIT_SOURCE_UNAVAILABLE,
    });
  });
});

test('AC3: exported field queries are read-only operations', () => {
  assert.match(PROJECT_FIELDS_QUERY, /^query ProjectFields/);
  assert.match(PROJECT_ITEM_FIELD_VALUES_QUERY, /^query ProjectItemFieldValues/);
  assert.doesNotMatch(PROJECT_FIELDS_QUERY, /\bmutation\b/i);
  assert.doesNotMatch(PROJECT_ITEM_FIELD_VALUES_QUERY, /\bmutation\b/i);
});

test('AC3: mutation document rejected before gh spawn', async () => {
  const counter = join(tmpdir(), `gh-mut-${Date.now()}`);
  writeFileSync(counter, '', 'utf8');
  const prevGh = process.env.ORCA_TELEMETRY_GH;
  const prevCounter = process.env.GH_STUB_COUNTER_FILE;
  process.env.ORCA_TELEMETRY_GH = ghStub;
  process.env.GH_STUB_COUNTER_FILE = counter;
  try {
    await expectCliError(
      graphql('mutation { updateProjectV2ItemFieldValue { projectV2Item { id } } }', {}),
      { code: 'usage_error', exitCode: EXIT_USAGE },
    );
    assert.equal(readFileSync(counter, 'utf8').trim(), '');
  } finally {
    if (prevGh === undefined) delete process.env.ORCA_TELEMETRY_GH;
    else process.env.ORCA_TELEMETRY_GH = prevGh;
    if (prevCounter === undefined) delete process.env.GH_STUB_COUNTER_FILE;
    else process.env.GH_STUB_COUNTER_FILE = prevCounter;
    rmSync(counter, { force: true });
  }
});
