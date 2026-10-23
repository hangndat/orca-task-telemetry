import assert from 'node:assert/strict';
import { test } from 'vitest';
import { EXIT_USAGE } from '../dist/errors.js';
import { runDoctorWithDeps } from '../dist/doctor.js';
import { SUPPORTED_SCHEMA_VERSION } from '../dist/db/migrate.js';

test('T32: doctor pass when core checks healthy', async () => {
  const report = await runDoctorWithDeps({
    nodeVersion: 'v24.1.0',
    ghAuthStatus: async () => ({
      authenticated: true,
      scopes: ['read:project', 'repo'],
    }),
    orcaVersion: async () => '1.4.237',
    codeburnVersion: async () => '0.9.27',
    readDbUserVersion: () => SUPPORTED_SCHEMA_VERSION,
  });
  assert.equal(report.summary, 'pass');
  assert.equal(report.exitCode, 0);
});

test('T32: doctor warn on missing sources still exits 0', async () => {
  const report = await runDoctorWithDeps({
    nodeVersion: 'v24.1.0',
    ghAuthStatus: async () => ({ authenticated: false, scopes: [] }),
    orcaVersion: async () => null,
    codeburnVersion: async () => null,
    readDbUserVersion: () => null,
  });
  assert.equal(report.summary, 'warn');
  assert.equal(report.exitCode, 0);
});

test('T32: doctor fail on unsupported node', async () => {
  const report = await runDoctorWithDeps({
    nodeVersion: 'v20.0.0',
  });
  assert.equal(report.summary, 'fail');
  assert.equal(report.exitCode, EXIT_USAGE);
  assert.ok(report.checks.some((c) => c.id === 'node' && c.status === 'fail'));
});

test('T32: doctor fail on future database schema', async () => {
  const report = await runDoctorWithDeps({
    nodeVersion: 'v24.0.0',
    appHome: '/tmp/home',
    readDbUserVersion: () => SUPPORTED_SCHEMA_VERSION + 10,
  });
  assert.equal(report.checks.find((c) => c.id === 'database')?.status, 'fail');
  assert.equal(report.summary, 'fail');
  assert.equal(report.exitCode, EXIT_USAGE);
});
