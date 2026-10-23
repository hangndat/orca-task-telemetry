import assert from 'node:assert/strict';
import path from 'node:path';
import pathWin32 from 'node:path/win32';
import { test } from 'vitest';
import { EXIT_USAGE } from '../dist/errors.js';
import {
  APP_DIR_NAME,
  CONFIG_FILE_NAME,
  DB_FILE_NAME,
  resolveAppPaths,
} from '../dist/paths.js';

function env(platform, overrides = {}) {
  return {
    platform,
    homedir: () => '/home/tester',
    env: {},
    ...overrides,
  };
}

test('AC1: macOS default app home', () => {
  const resolved = resolveAppPaths(env('darwin'));
  assert.equal(
    resolved.appHome,
    path.join('/home/tester', 'Library', 'Application Support', APP_DIR_NAME),
  );
  assert.equal(resolved.configPath, path.join(resolved.appHome, CONFIG_FILE_NAME));
  assert.equal(resolved.dbPath, path.join(resolved.appHome, DB_FILE_NAME));
});

test('AC1: Linux uses XDG_DATA_HOME when absolute', () => {
  const resolved = resolveAppPaths(
    env('linux', { env: { XDG_DATA_HOME: '/data/xdg' } }),
  );
  assert.equal(resolved.appHome, path.join('/data/xdg', APP_DIR_NAME));
});

test('AC1: Linux falls back to ~/.local/share', () => {
  const resolved = resolveAppPaths(env('linux'));
  assert.equal(
    resolved.appHome,
    path.join('/home/tester', '.local', 'share', APP_DIR_NAME),
  );
});

test('AC1: Windows uses LOCALAPPDATA', () => {
  const resolved = resolveAppPaths(
    env('win32', {
      homedir: () => 'C:\\Users\\tester',
      env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    }),
  );
  assert.equal(
    resolved.appHome,
    pathWin32.join('C:\\Users\\tester\\AppData\\Local', APP_DIR_NAME),
  );
});

test('AC1: Windows homedir fallback when LOCALAPPDATA unset', () => {
  const resolved = resolveAppPaths(
    env('win32', { homedir: () => 'C:\\Users\\tester', env: {} }),
  );
  assert.equal(
    resolved.appHome,
    pathWin32.join('C:\\Users\\tester', 'AppData', 'Local', APP_DIR_NAME),
  );
});

test('AC1: ORCA_TELEMETRY_HOME absolute override', () => {
  const resolved = resolveAppPaths(
    env('linux', { env: { ORCA_TELEMETRY_HOME: '/var/orca-telemetry' } }),
  );
  assert.equal(resolved.appHome, '/var/orca-telemetry');
});

test('AC1: unset ORCA_TELEMETRY_HOME uses platform default', () => {
  const resolved = resolveAppPaths(env('linux', { env: {} }));
  assert.equal(
    resolved.appHome,
    path.join('/home/tester', '.local', 'share', APP_DIR_NAME),
  );
});

test('AC1: rejects empty and whitespace-only ORCA_TELEMETRY_HOME', () => {
  for (const value of ['', '   ', '\t']) {
    assert.throws(
      () =>
        resolveAppPaths(
          env('linux', { env: { ORCA_TELEMETRY_HOME: value } }),
        ),
      (err) => {
        assert.equal(err.code, 'paths_error');
        assert.equal(err.exitCode, EXIT_USAGE);
        return true;
      },
      `expected paths_error for ORCA_TELEMETRY_HOME=${JSON.stringify(value)}`,
    );
  }
});

test('AC1: rejects relative ORCA_TELEMETRY_HOME', () => {
  assert.throws(
    () =>
      resolveAppPaths(
        env('linux', { env: { ORCA_TELEMETRY_HOME: 'relative/path' } }),
      ),
    (err) => {
      assert.equal(err.code, 'paths_error');
      assert.equal(err.exitCode, EXIT_USAGE);
      return true;
    },
  );
});

test('AC1: rejects relative LOCALAPPDATA on Windows', () => {
  assert.throws(
    () =>
      resolveAppPaths(
        env('win32', {
          homedir: () => 'C:\\Users\\tester',
          env: { LOCALAPPDATA: 'relative\\appdata' },
        }),
      ),
    (err) => err.code === 'paths_error',
  );
});

test('AC1: rejects relative XDG_DATA_HOME', () => {
  assert.throws(
    () =>
      resolveAppPaths(
        env('linux', { env: { XDG_DATA_HOME: 'relative/xdg' } }),
      ),
    (err) => {
      assert.equal(err.code, 'paths_error');
      return true;
    },
  );
});
