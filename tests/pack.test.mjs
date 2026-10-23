import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  REPO_ROOT,
  assertBuiltPackageLayout,
  createIsolatedPackageCopy,
} from '../scripts/test-pack.mjs';

test('built source tree has dist and bin before pack', () => {
  assertBuiltPackageLayout(REPO_ROOT);
});

test('isolated copy without dist fails layout check', () => {
  const copyRoot = createIsolatedPackageCopy(REPO_ROOT);
  try {
    rmSync(join(copyRoot, 'dist'), { recursive: true, force: true });
    assert.throws(
      () => assertBuiltPackageLayout(copyRoot),
      (err) => err.code === 'pack_test_failed' && /dist/.test(err.message),
    );
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test('isolated copy with missing bin target fails layout check', () => {
  const copyRoot = createIsolatedPackageCopy(REPO_ROOT);
  try {
    const pkgPath = join(copyRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.bin = { 'orca-telemetry': 'dist/missing-cli.js' };
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    assert.throws(
      () => assertBuiltPackageLayout(copyRoot),
      (err) => err.code === 'pack_test_failed' && /bin/.test(err.message),
    );
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test('isolated copy without bin field fails layout check', () => {
  const copyRoot = createIsolatedPackageCopy(REPO_ROOT);
  try {
    const pkgPath = join(copyRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    delete pkg.bin;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    assert.throws(
      () => assertBuiltPackageLayout(copyRoot),
      (err) => err.code === 'pack_test_failed' && /bin/.test(err.message),
    );
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
});
