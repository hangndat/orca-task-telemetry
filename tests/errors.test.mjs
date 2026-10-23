import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CliError,
  EXIT_ENVIRONMENT,
  EXIT_USAGE,
  nodeVersionError,
  notImplemented,
  unknownCommand,
  usageError,
} from '../dist/errors.js';

test('CliError exposes stable code and exitCode', () => {
  const err = new CliError({
    code: 'sample_error',
    message: 'Something failed.',
    hint: 'Try again.',
    exitCode: EXIT_USAGE,
  });
  assert.equal(err.code, 'sample_error');
  assert.equal(err.message, 'Something failed.');
  assert.equal(err.hint, 'Try again.');
  assert.equal(err.exitCode, EXIT_USAGE);
  assert.ok(err instanceof Error);
});

test('factory helpers use contract exit codes', () => {
  assert.equal(usageError('bad').code, 'usage_error');
  assert.equal(usageError('bad').exitCode, EXIT_USAGE);
  assert.equal(unknownCommand('x').code, 'unknown_command');
  assert.equal(notImplemented('init').code, 'not_implemented');
  assert.equal(notImplemented('init').exitCode, EXIT_USAGE);
});

test('nodeVersionError uses environment exit code', () => {
  assert.equal(nodeVersionError('old').exitCode, EXIT_ENVIRONMENT);
  assert.equal(nodeVersionError('old').code, 'environment_error');
});
