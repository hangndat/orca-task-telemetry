import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  EXIT_ENVIRONMENT,
  EXIT_SOURCE_UNAVAILABLE,
  EXIT_USAGE,
} from '../dist/errors.js';
import { graphql } from '../dist/github/client.js';

const dir = dirname(fileURLToPath(import.meta.url));
const stub = resolve(dir, 'helpers/gh-stub.mjs');
const fixturePage1 = resolve(dir, 'fixtures/github/project-items-page1.json');

function stubEnv(overrides = {}) {
  return {
    ORCA_TELEMETRY_GH: stub,
    GH_STUB_STDOUT: overrides.stdout ?? '{}',
    GH_STUB_STDERR: overrides.stderr ?? '',
    GH_STUB_EXIT_CODE: overrides.exitCode ?? '0',
    ...overrides.extra,
  };
}


/** graphql with env injected via ORCA_TELEMETRY_GH only (production path). */
async function callGraphql(query, variables, env, opts = {}) {
  const prev = process.env.ORCA_TELEMETRY_GH;
  const prevStdout = process.env.GH_STUB_STDOUT;
  const prevStderr = process.env.GH_STUB_STDERR;
  const prevExit = process.env.GH_STUB_EXIT_CODE;
  const prevCounter = process.env.GH_STUB_COUNTER_FILE;
  const prevRecord = process.env.GH_STUB_RECORD_FILE;
  const prevDelay = process.env.GH_STUB_DELAY_MS;

  Object.assign(process.env, env);
  try {
    return await graphql(query, variables, opts);
  } finally {
    if (prev === undefined) delete process.env.ORCA_TELEMETRY_GH;
    else process.env.ORCA_TELEMETRY_GH = prev;
    if (prevStdout === undefined) delete process.env.GH_STUB_STDOUT;
    else process.env.GH_STUB_STDOUT = prevStdout;
    if (prevStderr === undefined) delete process.env.GH_STUB_STDERR;
    else process.env.GH_STUB_STDERR = prevStderr;
    if (prevExit === undefined) delete process.env.GH_STUB_EXIT_CODE;
    else process.env.GH_STUB_EXIT_CODE = prevExit;
    if (prevCounter === undefined) delete process.env.GH_STUB_COUNTER_FILE;
    else process.env.GH_STUB_COUNTER_FILE = prevCounter;
    if (prevRecord === undefined) delete process.env.GH_STUB_RECORD_FILE;
    else process.env.GH_STUB_RECORD_FILE = prevRecord;
    if (prevDelay === undefined) delete process.env.GH_STUB_DELAY_MS;
    else process.env.GH_STUB_DELAY_MS = prevDelay;
  }
}

function expectCliError(promise, { code, exitCode, hintIncludes }) {
  return promise.then(
    () => {
      assert.fail('expected CliError');
    },
    (err) => {
      assert.equal(err.code, code);
      assert.equal(err.exitCode, exitCode);
      if (hintIncludes) {
        assert.ok(err.hint?.includes(hintIncludes), err.hint);
      }
      assert.ok(err.message.length <= 300, 'message should be truncated');
      return err;
    },
  );
}

test('AC1: success returns parsed data from fixture', async () => {
  const raw = readFileSync(fixturePage1, 'utf8');
  const env = stubEnv({ stdout: raw });
  const data = await callGraphql(
    'query { node(id: "x") { id } }',
    { id: 'PVT_kwHOAGoDWs4BoZ5m' },
    env,
    { ghPath: stub },
  );
  assert.equal(data.node.id, 'PVT_kwHOAGoDWs4BoZ5m');
  assert.equal(data.node.items.totalCount, 103);
});

test('AC2: insufficient scopes → github_scope_missing exit 3', async () => {
  const stdout = JSON.stringify({
    errors: [
      {
        message: 'read:project scope required',
        extensions: { type: 'INSUFFICIENT_SCOPES' },
      },
    ],
  });
  await expectCliError(
    callGraphql('query { viewer { login } }', {}, stubEnv({ stdout }), {
      ghPath: stub,
    }),
    {
      code: 'github_scope_missing',
      exitCode: EXIT_ENVIRONMENT,
      hintIncludes: 'read:project',
    },
  );
});

test('AC2: not authenticated → github_auth_required exit 3', async () => {
  await expectCliError(
    callGraphql(
      'query { viewer { login } }',
      {},
      stubEnv({
        exitCode: '1',
        stderr: 'To use GitHub CLI, please run: gh auth login',
      }),
      { ghPath: stub },
    ),
    {
      code: 'github_auth_required',
      exitCode: EXIT_ENVIRONMENT,
      hintIncludes: 'gh auth login',
    },
  );
});

test('AC2: gh not found → gh_not_found exit 3', async () => {
  await expectCliError(
    graphql('query { viewer { login } }', {}, {
      ghPath: '/no/such/gh-binary',
      timeoutMs: 5_000,
    }),
    { code: 'gh_not_found', exitCode: EXIT_ENVIRONMENT },
  );
});

test('AC2: rate limit → github_rate_limited exit 4 with resetAt hint', async () => {
  const stdout = JSON.stringify({
    data: { rateLimit: { resetAt: '2026-10-23T15:33:22Z' } },
    errors: [{ message: 'API rate limit exceeded', type: 'RATE_LIMITED' }],
  });
  await expectCliError(
    callGraphql('query { viewer { login } }', {}, stubEnv({ stdout }), {
      ghPath: stub,
    }),
    {
      code: 'github_rate_limited',
      exitCode: EXIT_SOURCE_UNAVAILABLE,
      hintIncludes: '2026-10-23T15:33:22Z',
    },
  );
});

test('AC2: timeout → github_unavailable exit 4', async () => {
  await expectCliError(
    callGraphql(
      'query { viewer { login } }',
      {},
      stubEnv({
        stdout: '{"data":{}}',
        extra: { GH_STUB_DELAY_MS: '60000' },
      }),
      { ghPath: stub, timeoutMs: 200 },
    ),
    { code: 'github_unavailable', exitCode: EXIT_SOURCE_UNAVAILABLE },
  );
});

test('AC2: invalid JSON → github_bad_response exit 4', async () => {
  await expectCliError(
    callGraphql(
      'query { viewer { login } }',
      {},
      stubEnv({ stdout: 'not-json{{{' }),
      { ghPath: stub },
    ),
    { code: 'github_bad_response', exitCode: EXIT_SOURCE_UNAVAILABLE },
  );
});

test('AC3: mutation rejected without invoking gh stub', async () => {
  const counter = join(tmpdir(), `gh-stub-count-${Date.now()}`);
  writeFileSync(counter, '', 'utf8');
  const env = stubEnv({
    stdout: '{}',
    extra: { GH_STUB_COUNTER_FILE: counter },
  });

  await expectCliError(
    callGraphql('mutation { x }', {}, env, { ghPath: process.execPath }),
    { code: 'usage_error', exitCode: EXIT_USAGE },
  );

  const lines = readFileSync(counter, 'utf8').trim();
  assert.equal(lines, '', 'gh stub must not run for mutations');
  rmSync(counter, { force: true });
});

test('AC4: spawn uses gh api graphql --input - without token argv', async () => {
  const record = join(tmpdir(), `gh-stub-record-${Date.now()}`);
  const env = stubEnv({
    stdout: '{"data":{"viewer":{"login":"u"}}}',
    extra: { GH_STUB_RECORD_FILE: record },
  });
  await callGraphql('query { viewer { login } }', {}, env, {
    ghPath: stub,
  });
  const recorded = JSON.parse(readFileSync(record, 'utf8'));
  assert.deepEqual(recorded.argv, ['api', 'graphql', '--input', '-']);
  assert.ok(recorded.stdinLength > 0);
  const joinedArgv = recorded.argv.join(' ');
  assert.doesNotMatch(joinedArgv, /token|pat|bearer/i);
  rmSync(record, { force: true });
});
