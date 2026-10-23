import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE } from '../dist/errors.js';
import {
  CONFIG_VERSION,
  emptyConfig,
  loadConfig,
  parseConfigJson,
  saveConfig,
} from '../dist/config.js';

test('AC2: roundtrip config v1', () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-config-'));
  const config = emptyConfig();
  config.profiles['R_kgTEST'] = {};
  saveConfig(home, config);
  const loaded = loadConfig(home);
  assert.deepEqual(loaded, config);
  const onDisk = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.equal(onDisk.version, CONFIG_VERSION);
  rmSync(home, { recursive: true, force: true });
});

test('AC2: missing config file returns empty in-memory config', () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-config-missing-'));
  assert.deepEqual(loadConfig(home), emptyConfig());
  rmSync(home, { recursive: true, force: true });
});

test('AC2: invalid JSON and shape/version errors', () => {
  assert.throws(
    () => parseConfigJson('{'),
    (err) => err.code === 'config_parse_error',
  );
  assert.throws(
    () => parseConfigJson('[]'),
    (err) => err.code === 'config_invalid_shape',
  );
  assert.throws(
    () => parseConfigJson('{"version":2,"profiles":{}}'),
    (err) => {
      assert.equal(err.code, 'config_unsupported_version');
      assert.equal(err.exitCode, EXIT_SOURCE_UNAVAILABLE);
      return true;
    },
  );
  assert.throws(
    () => parseConfigJson('{"version":1,"profiles":[]}'),
    (err) => err.code === 'config_invalid_shape',
  );
});

test('AC3: atomic write leaves valid JSON and preserves original on failure', () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-config-atomic-'));
  const good = emptyConfig();
  saveConfig(home, good);
  const before = readFileSync(join(home, 'config.json'), 'utf8');

  if (process.platform !== 'win32') {
    const mode = lstatSync(join(home, 'config.json')).mode & 0o777;
    assert.equal(mode, 0o600);
    const dirMode = lstatSync(home).mode & 0o777;
    assert.equal(dirMode, 0o700);
  }

  const after = readFileSync(join(home, 'config.json'), 'utf8');
  assert.equal(after, before);

  const realHome = mkdtempSync(join(tmpdir(), 'orca-config-real-'));
  const linkHome = join(tmpdir(), `orca-config-link-${Date.now()}`);
  symlinkSync(realHome, linkHome);
  try {
    saveConfig(linkHome, good);
    assert.fail('expected save to refuse symlink app home');
  } catch (err) {
    assert.equal(err.code, 'config_write_error');
  }
  rmSync(linkHome);
  rmSync(realHome, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
