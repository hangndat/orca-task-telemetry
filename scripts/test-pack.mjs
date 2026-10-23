import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const TAR = 'tar';

/**
 * @param {string} message
 */
function fail(message) {
  const err = new Error(message);
  err.code = 'pack_test_failed';
  throw err;
}

/**
 * @param {string} packageRoot
 */
export function readPackageJson(packageRoot) {
  return JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  );
}

/**
 * @param {string} packageRoot
 */
export function assertBuiltPackageLayout(packageRoot) {
  const pkg = readPackageJson(packageRoot);
  const binRel = pkg.bin?.['orca-telemetry'];
  if (typeof binRel !== 'string' || binRel.length === 0) {
    fail('package.json thiếu bin "orca-telemetry"');
  }
  const binPath = join(packageRoot, binRel);
  if (!existsSync(binPath)) {
    fail(`thiếu file bin: ${binRel}`);
  }
  const distDir = join(packageRoot, 'dist');
  if (!existsSync(distDir)) {
    fail('thiếu thư mục dist/ (chạy pnpm build trước khi pack)');
  }
  const cliJs = join(distDir, 'cli.js');
  if (!existsSync(cliJs)) {
    fail('thiếu dist/cli.js trong bản build');
  }
  return { pkg, binRel, binPath };
}

/**
 * @param {string} tarball
 * @returns {string[]}
 */
export function listTarballMemberPaths(tarball) {
  const out = execFileSync(TAR, ['-tzf', tarball], { encoding: 'utf8' });
  return out
    .trim()
    .split('\n')
    .map((line) => line.replace(/^\.\//, ''))
    .filter((line) => line.length > 0);
}

/**
 * @param {string} tarball
 * @param {import('node:fs').Stats} [pkg]
 */
export function assertTarballContainsDistAndBin(tarball, pkgJson) {
  const members = listTarballMemberPaths(tarball);
  const binRel = pkgJson.bin['orca-telemetry'];
  const normalizedBin = binRel.replace(/^\.\//, '');
  const hasBin = members.some(
    (m) => m === `package/${normalizedBin}` || m.endsWith(`/${normalizedBin}`),
  );
  const hasDistCli = members.some(
    (m) => m === 'package/dist/cli.js' || m.endsWith('/dist/cli.js'),
  );
  if (!hasBin) {
    fail(`tarball không chứa bin ${normalizedBin}: ${tarball}`);
  }
  if (!hasDistCli) {
    fail(`tarball không chứa dist/cli.js: ${tarball}`);
  }
}

/**
 * @param {string} dir
 */
function findTarballInDir(dir) {
  const names = readdirSync(dir).filter((n) => n.endsWith('.tgz'));
  if (names.length !== 1) {
    fail(
      `kỳ vọng đúng một .tgz trong ${dir}, thấy: ${names.join(', ') || '(none)'}`,
    );
  }
  return join(dir, names[0]);
}

/**
 * @param {string} cwd
 */
export function captureGitRepoInventory(cwd) {
  const status = execFileSync(GIT, ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
  }).trimEnd();
  const untracked = execFileSync(
    GIT,
    ['ls-files', '-o', '--exclude-standard'],
    { cwd, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .sort();
  return { status, untracked };
}

/**
 * @param {{ status: string; untracked: string[] }} before
 * @param {{ status: string; untracked: string[] }} after
 */
export function assertGitRepoUnchanged(before, after) {
  if (before.status !== after.status) {
    fail(
      `git status thay đổi sau khi chạy CLI:\nbefore:\n${before.status}\nafter:\n${after.status}`,
    );
  }
  const bu = JSON.stringify(before.untracked);
  const au = JSON.stringify(after.untracked);
  if (bu !== au) {
    fail(
      `danh sách untracked thay đổi:\nbefore: ${bu}\nafter: ${au}`,
    );
  }
}

/**
 * @param {string} prefix
 */
function resolveInstalledCliBin(prefix) {
  const name =
    process.platform === 'win32' ? 'orca-telemetry.cmd' : 'orca-telemetry';
  return join(prefix, 'node_modules', '.bin', name);
}

/**
 * @param {string} prefix
 * @param {string} tarball
 */
export function npmInstallTarballToPrefix(prefix, tarball) {
  execFileSync(
    NPM,
    [
      'install',
      tarball,
      '--prefix',
      prefix,
      '--omit=dev',
      '--ignore-scripts',
      '--no-fund',
      '--no-audit',
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );
}

/**
 * @param {string} binPath
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string> }} options
 */
export function runInstalledCli(binPath, args, options = {}) {
  const result = spawnSync(binPath, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
  return result;
}

/**
 * @param {string} remotes
 */
function initEmptyGitRepo(remotes = []) {
  const root = mkdtempSync(join(tmpdir(), 'orca-pack-git-'));
  execFileSync(GIT, ['init'], { cwd: root });
  execFileSync(GIT, ['config', 'user.email', 'pack-test@example.com'], {
    cwd: root,
  });
  execFileSync(GIT, ['config', 'user.name', 'pack-test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# pack isolation target\n');
  execFileSync(GIT, ['add', 'README.md'], { cwd: root });
  execFileSync(GIT, ['commit', '-m', 'init'], { cwd: root });
  for (const [name, url] of remotes) {
    execFileSync(GIT, ['remote', 'add', name, url], { cwd: root });
  }
  return root;
}

/**
 * @param {string[]} temps
 */
function cleanupTemps(temps) {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * @param {string} [packageRoot]
 */
export function runIsolatedPackInstallTest(packageRoot = REPO_ROOT) {
  const temps = [];
  try {
    const { pkg } = assertBuiltPackageLayout(packageRoot);

    const packDest = mkdtempSync(join(tmpdir(), 'orca-pack-out-'));
    temps.push(packDest);
    execFileSync(PNPM, ['pack', '--pack-destination', packDest], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const tarball = findTarballInDir(packDest);
    assertTarballContainsDistAndBin(tarball, pkg);

    const npmPrefix = mkdtempSync(join(tmpdir(), 'orca-pack-npm-'));
    temps.push(npmPrefix);
    npmInstallTarballToPrefix(npmPrefix, tarball);
    const cliBin = resolveInstalledCliBin(npmPrefix);
    if (!existsSync(cliBin)) {
      fail(`sau cài đặt không thấy bin: ${cliBin}`);
    }

    const telemetryHome = mkdtempSync(join(tmpdir(), 'orca-pack-home-'));
    temps.push(telemetryHome);

    const gitRepo = initEmptyGitRepo();
    temps.push(gitRepo);
    const before = captureGitRepoInventory(gitRepo);

    const env = {
      ORCA_TELEMETRY_HOME: telemetryHome,
      PATH: process.env.PATH ?? '',
    };

    const help = runInstalledCli(cliBin, ['--help'], { cwd: gitRepo, env });
    if (help.status !== 0) {
      fail(`--help thất bại: ${help.stderr || help.stdout}`);
    }

    const version = runInstalledCli(cliBin, ['--version'], { cwd: gitRepo, env });
    if (version.status !== 0) {
      fail(`--version thất bại: ${version.stderr || version.stdout}`);
    }
    if (!version.stdout.includes(pkg.version)) {
      fail(`--version không khớp ${pkg.version}: ${version.stdout}`);
    }

    const doctor = runInstalledCli(cliBin, ['doctor'], { cwd: gitRepo, env });
    if (doctor.status !== 0) {
      fail(`doctor thất bại: ${doctor.stderr || doctor.stdout}`);
    }

    const doctorJson = runInstalledCli(cliBin, ['doctor', '--json'], {
      cwd: gitRepo,
      env,
    });
    if (doctorJson.status !== 0) {
      fail(`doctor --json thất bại: ${doctorJson.stderr || doctorJson.stdout}`);
    }
    const parsed = JSON.parse(doctorJson.stdout.trim());
    if (parsed.ok !== true) {
      fail(`doctor --json ok !== true: ${doctorJson.stdout}`);
    }

    const after = captureGitRepoInventory(gitRepo);
    assertGitRepoUnchanged(before, after);

    return {
      tarball,
      npmPrefix,
      telemetryHome,
      gitRepo,
      packageVersion: pkg.version,
    };
  } finally {
    cleanupTemps(temps);
  }
}

/**
 * Bản sao package tối thiểu (không node_modules) để negative test.
 * @param {string} sourceRoot
 */
export function createIsolatedPackageCopy(sourceRoot) {
  const dest = mkdtempSync(join(tmpdir(), 'orca-pack-copy-'));
  cpSync(sourceRoot, dest, {
    recursive: true,
    filter: (src) => {
      const base = src.slice(sourceRoot.length + 1);
      if (base.startsWith('node_modules')) return false;
      if (base.startsWith('.git')) return false;
      return true;
    },
  });
  return dest;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  try {
    runIsolatedPackInstallTest(REPO_ROOT);
    console.log('pack/install isolation: OK');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
