import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE } from '../dist/errors.js';
import {
  CONFIG_VERSION,
  createDefaultConfigIo,
  emptyConfig,
  loadConfig,
  parseConfigJson,
  saveConfig,
} from '../dist/config.js';

function listTempFiles(home) {
  return readdirSync(home).filter((name) => name.includes('.config.json.') && name.endsWith('.tmp'));
}

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
    () => parseConfigJson('{"version":0,"profiles":{}}'),
    (err) => err.code === 'config_unsupported_version',
  );
  assert.throws(
    () => parseConfigJson('{"version":1,"profiles":[]}'),
    (err) => err.code === 'config_invalid_shape',
  );
  assert.throws(
    () => parseConfigJson('{"version":1,"profiles":"x"}'),
    (err) => err.code === 'config_invalid_shape',
  );
  assert.throws(
    () => parseConfigJson('{"version":1,"profiles":null}'),
    (err) => err.code === 'config_invalid_shape',
  );
});

test('AC3: successful save sets POSIX permissions', () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-config-perms-'));
  saveConfig(home, emptyConfig());
  if (process.platform !== 'win32') {
    const mode = lstatSync(join(home, 'config.json')).mode & 0o777;
    assert.equal(mode, 0o600);
    const dirMode = lstatSync(home).mode & 0o777;
    assert.equal(dirMode, 0o700);
  }
  rmSync(home, { recursive: true, force: true });
});

test('AC3: failed rename preserves original config and removes temp file', () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-config-fail-rename-'));
  const original = emptyConfig();
  original.profiles['R_keep'] = {};
  saveConfig(home, original);
  const beforeBytes = readFileSync(join(home, 'config.json'), 'utf8');

  const baseIo = createDefaultConfigIo();
  let renameCalls = 0;
  const io = {
    ...baseIo,
    renameSync: (...args) => {
      renameCalls += 1;
      throw new Error('simulated rename failure');
    },
    randomTempSuffix: () => 'deadbeef',
  };

  const updated = emptyConfig();
  updated.profiles['R_new'] = {};
  try {
    saveConfig(home, updated, io);
    assert.fail('expected saveConfig to throw');
  } catch (err) {
    assert.equal(err.code, 'config_write_error');
    assert.equal(err.exitCode, EXIT_SOURCE_UNAVAILABLE);
    assert.equal(renameCalls, 1);
  }

  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), beforeBytes);
  assert.equal(listTempFiles(home).length, 0);

  saveConfig(home, updated);
  const loaded = loadConfig(home);
  assert.ok(loaded.profiles['R_new']);
  rmSync(home, { recursive: true, force: true });
});

test('AC3: refuses symlink app home', () => {
  const realHome = mkdtempSync(join(tmpdir(), 'orca-config-real-'));
  const linkHome = join(tmpdir(), `orca-config-link-${Date.now()}`);
  symlinkSync(realHome, linkHome);
  try {
    saveConfig(linkHome, emptyConfig());
    assert.fail('expected save to refuse symlink app home');
  } catch (err) {
    assert.equal(err.code, 'config_write_error');
  }
  rmSync(linkHome);
  rmSync(realHome, { recursive: true, force: true });
});
