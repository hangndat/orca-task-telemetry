import { spawnSync } from 'node:child_process';
import { CliError, EXIT_USAGE } from '../errors.js';

export type GhAuthStatus = {
  authenticated: boolean;
  scopes: string[];
  known: boolean;
};

/** Inspect only the active github.com account; never request or retain a token. */
export function readGhAuthStatus(): GhAuthStatus {
  const executable = process.env['ORCA_TELEMETRY_GH'] || 'gh';
  const args = ['auth', 'status', '--json', 'hosts', '--no-refresh'];
  const isScript = /\.m?js$/.test(executable);
  const command = isScript ? process.execPath : executable;
  const argv = isScript ? [executable, ...args] : args;
  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    return { authenticated: false, scopes: [], known: false };
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== 'object' || !('hosts' in parsed)) {
      return { authenticated: false, scopes: [], known: false };
    }
    const hosts = parsed.hosts;
    if (!hosts || typeof hosts !== 'object' || !('github.com' in hosts)) {
      return { authenticated: false, scopes: [], known: true };
    }
    const accounts = hosts['github.com'];
    if (!Array.isArray(accounts)) {
      return { authenticated: false, scopes: [], known: false };
    }
    const active = accounts.find((account: unknown) =>
      account !== null && typeof account === 'object' && 'active' in account && account.active === true,
    );
    if (!active) {
      return { authenticated: false, scopes: [], known: true };
    }
    if (active.state !== 'success') {
      return { authenticated: false, scopes: [], known: true };
    }
    if (typeof active.scopes !== 'string') {
      return { authenticated: true, scopes: [], known: false };
    }
    return {
      authenticated: true,
      scopes: active.scopes.split(',').map((scope: string) => scope.trim()).filter(Boolean),
      known: true,
    };
  } catch {
    return { authenticated: false, scopes: [], known: false };
  }
}

export function requireGhProjectWriteScope(status: GhAuthStatus = readGhAuthStatus()): void {
  if (!status.known) {
    throw new CliError({
      code: 'github_auth_unverified',
      message: 'Could not verify the active github.com account and its project scope.',
      hint: 'Run gh auth status --json hosts --no-refresh and verify the active account.',
      exitCode: EXIT_USAGE,
    });
  }
  if (!status.authenticated) {
    throw new CliError({
      code: 'github_auth_required',
      message: 'GitHub CLI is not authenticated for github.com.',
      hint: 'gh auth login',
      exitCode: EXIT_USAGE,
    });
  }
  if (!status.scopes.includes('project')) {
    throw new CliError({
      code: 'github_scope_missing',
      message: 'The active github.com account is missing the project scope required for --apply.',
      hint: 'gh auth refresh -s project',
      exitCode: EXIT_USAGE,
    });
  }
}
