import { spawn } from 'node:child_process';
import { CliError, EXIT_USAGE } from '../errors.js';

export type GhAuthStatus = {
  authenticated: boolean;
  scopes: string[];
  known: boolean;
};

/** Inspect only the active github.com account; never request or retain a token. */
export async function readGhAuthStatus(): Promise<GhAuthStatus> {
  const executable = process.env['ORCA_TELEMETRY_GH'] || 'gh';
  const args = ['auth', 'status', '--json', 'hosts', '--no-refresh'];
  const isScript = /\.m?js$/.test(executable);
  const command = isScript ? process.execPath : executable;
  const argv = isScript ? [executable, ...args] : args;
  const result = await new Promise<{ stdout: string; ok: boolean }>((resolve) => {
    const child = spawn(command, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopped = false;
    let settled = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ stdout: ok ? Buffer.concat(chunks).toString('utf8') : '', ok });
    };
    const stop = () => {
      if (stopped || settled) return;
      stopped = true;
      child.kill('SIGTERM');
      termTimer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGKILL');
        killTimer = setTimeout(() => finish(false), 250);
      }, 250);
    };
    const timeoutTimer = setTimeout(stop, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { stop(); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) stop();
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(!stopped && code === 0));
  });
  if (!result.ok) {
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

export function requireGhProjectWriteScope(status: GhAuthStatus): void {
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
