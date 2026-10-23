import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { EXIT_ENVIRONMENT, EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE } from '../dist/errors.js';
import {
  buildProjectItemEditNumberArgv,
  setProjectItemNumberField,
} from '../dist/writeback/gh-apply.js';

const dir = dirname(fileURLToPath(import.meta.url));
const stub = resolve(dir, 'helpers/gh-project-item-edit-stub.mjs');

const SAMPLE = {
  projectItemId: 'PVTI_abc123',
  fieldId: 'PVTF_field456',
  projectId: 'PVT_project789',
  number: 12.345678,
};

test('AC1: argv uses node IDs and single --number per call', () => {
  const argv = buildProjectItemEditNumberArgv(SAMPLE);
  assert.deepEqual(argv, [
    'project',
    'item-edit',
    '--id',
    SAMPLE.projectItemId,
    '--field-id',
    SAMPLE.fieldId,
    '--project-id',
    SAMPLE.projectId,
    '--number',
    '12.345678',
  ]);
  assert.equal(argv.filter((a) => a === '--number').length, 1);
  const forbidden = [
    '--clear',
    '--text',
    '--field',
    '--owner',
    '--url',
    '--format',
  ];
  for (const flag of forbidden) {
    assert.ok(!argv.includes(flag), `unexpected ${flag}`);
  }
});

test('AC1: stub records exact argv for setProjectItemNumberField', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'gh-item-edit-log-'));
  const logFile = join(logDir, 'invocations.ndjson');
  process.env.GH_ITEM_EDIT_STUB_LOG_PATH = logFile;
  await setProjectItemNumberField(SAMPLE, { ghPath: stub, timeoutMs: 5_000 });
  const line = JSON.parse(readFileSync(logFile, 'utf8').trim());
  assert.deepEqual(line.argv, buildProjectItemEditNumberArgv(SAMPLE));
  rmSync(logDir, { recursive: true, force: true });
  delete process.env.GH_ITEM_EDIT_STUB_LOG_PATH;
});

test('AC1: finite zero is accepted', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'gh-item-edit-zero-'));
  const logFile = join(logDir, 'invocations.ndjson');
  process.env.GH_ITEM_EDIT_STUB_LOG_PATH = logFile;
  await setProjectItemNumberField({ ...SAMPLE, number: 0 }, { ghPath: stub });
  const line = JSON.parse(readFileSync(logFile, 'utf8').trim());
  assert.equal(line.argv.at(-1), '0');
  rmSync(logDir, { recursive: true, force: true });
  delete process.env.GH_ITEM_EDIT_STUB_LOG_PATH;
});

test('AC1: validation rejects missing IDs before stub spawn', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'gh-item-edit-validate-'));
  const logFile = join(logDir, 'invocations.ndjson');
  process.env.GH_ITEM_EDIT_STUB_LOG_PATH = logFile;
  await assert.rejects(
    () =>
      setProjectItemNumberField({ ...SAMPLE, projectItemId: '  ' }, { ghPath: stub }),
    (err) => err.code === 'usage_error' && err.exitCode === EXIT_USAGE,
  );
  assert.equal(existsSync(logFile), false);
  rmSync(logDir, { recursive: true, force: true });
  delete process.env.GH_ITEM_EDIT_STUB_LOG_PATH;
});

test('AC1: non-finite number rejected before spawn', () => {
  assert.throws(
    () => buildProjectItemEditNumberArgv({ ...SAMPLE, number: Number.NaN }),
    (err) => err.code === 'usage_error',
  );
  assert.throws(
    () => buildProjectItemEditNumberArgv({ ...SAMPLE, number: Number.POSITIVE_INFINITY }),
    (err) => err.code === 'usage_error',
  );
});

test('AC2: nonzero exit maps to github_apply_failed without stderr leak', async () => {
  const sentinel = 'ghp_LEAK_SENTINEL_TOKEN_item_edit_test';
  process.env.GH_ITEM_EDIT_STUB_EXIT_CODE = '1';
  process.env.GH_ITEM_EDIT_STUB_STDERR = `${sentinel}\napply failed\n`;
  await assert.rejects(
    () => setProjectItemNumberField(SAMPLE, { ghPath: stub }),
    (err) => {
      assert.equal(err.code, 'github_apply_failed');
      assert.equal(err.exitCode, EXIT_SOURCE_UNAVAILABLE);
      assert.ok(!err.message.includes(sentinel));
      assert.ok(err.message.includes('<REDACTED>'));
      assert.ok(err.message.length <= 300);
      return true;
    },
  );
  delete process.env.GH_ITEM_EDIT_STUB_EXIT_CODE;
  delete process.env.GH_ITEM_EDIT_STUB_STDERR;
});

test('AC2: missing gh binary surfaces gh_not_found', async () => {
  await assert.rejects(
    () => setProjectItemNumberField(SAMPLE, { ghPath: '/no/such/gh-binary' }),
    (err) => err.code === 'gh_not_found' && err.exitCode === EXIT_ENVIRONMENT,
  );
});

test('AC2: timeout maps to github_unavailable', async () => {
  process.env.GH_ITEM_EDIT_STUB_DELAY_MS = '50';
  await assert.rejects(
    () => setProjectItemNumberField(SAMPLE, { ghPath: stub, timeoutMs: 5 }),
    (err) => err.code === 'github_unavailable',
  );
  delete process.env.GH_ITEM_EDIT_STUB_DELAY_MS;
});

test('F03: timeout remains failure when child handles SIGTERM and exits zero', async () => {
  process.env.GH_ITEM_EDIT_STUB_SIGNAL = 'zero';
  process.env.GH_ITEM_EDIT_STUB_DELAY_MS = '3000';
  try {
    await assert.rejects(
      () => setProjectItemNumberField(SAMPLE, { ghPath: stub, timeoutMs: 300 }),
      (err) => err.code === 'github_unavailable' && /remote write state is unknown/.test(err.message),
    );
  } finally {
    delete process.env.GH_ITEM_EDIT_STUB_SIGNAL;
    delete process.env.GH_ITEM_EDIT_STUB_DELAY_MS;
  }
});

test('F03: ignored SIGTERM escalates to SIGKILL and settles promptly', async () => {
  process.env.GH_ITEM_EDIT_STUB_SIGNAL = 'ignore';
  process.env.GH_ITEM_EDIT_STUB_DELAY_MS = '3000';
  const started = Date.now();
  try {
    await assert.rejects(
      () => setProjectItemNumberField(SAMPLE, { ghPath: stub, timeoutMs: 300 }),
      (err) => err.code === 'github_unavailable',
    );
    assert.ok(Date.now() - started < 2000);
  } finally {
    delete process.env.GH_ITEM_EDIT_STUB_SIGNAL;
    delete process.env.GH_ITEM_EDIT_STUB_DELAY_MS;
  }
});

test('F03: output overflow fails even if child exits zero on SIGTERM', async () => {
  process.env.GH_ITEM_EDIT_STUB_SIGNAL = 'zero';
  process.env.GH_ITEM_EDIT_STUB_STDOUT = 'x'.repeat(1000);
  try {
    await assert.rejects(
      () => setProjectItemNumberField(SAMPLE, { ghPath: stub, maxBuffer: 10 }),
      (err) => err.code === 'github_apply_failed' && /remote write state is unknown/.test(err.message),
    );
  } finally {
    delete process.env.GH_ITEM_EDIT_STUB_SIGNAL;
    delete process.env.GH_ITEM_EDIT_STUB_STDOUT;
  }
});

test('F03: invalid process bounds are rejected before spawn', async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxBuffer: -1 }, { maxBuffer: NaN }]) {
    await assert.rejects(
      () => setProjectItemNumberField(SAMPLE, { ghPath: stub, ...options }),
      (err) => err.code === 'usage_error' && err.exitCode === EXIT_USAGE,
    );
  }
});

test('AC2: scope hint in stderr maps to github_scope_missing', async () => {
  process.env.GH_ITEM_EDIT_STUB_EXIT_CODE = '1';
  process.env.GH_ITEM_EDIT_STUB_STDERR = 'HTTP 403: insufficient_scopes\n';
  await assert.rejects(
    () => setProjectItemNumberField(SAMPLE, { ghPath: stub }),
    (err) => {
      assert.equal(err.code, 'github_scope_missing');
      assert.equal(err.hint, 'gh auth refresh -s project');
      return true;
    },
  );
  delete process.env.GH_ITEM_EDIT_STUB_EXIT_CODE;
  delete process.env.GH_ITEM_EDIT_STUB_STDERR;
});
