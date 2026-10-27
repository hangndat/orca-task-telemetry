import { spawn } from 'node:child_process';
import {
  CliError,
  EXIT_ENVIRONMENT,
  EXIT_SOURCE_UNAVAILABLE,
  EXIT_USAGE,
} from '../errors.js';

/** Only build with live evidence in docs/discovery.md (not a semver range). */
export const ORCA_VERIFIED_VERSION = '1.4.241';
export const DEFAULT_ORCA_TIMEOUT_MS = 60_000;
export const DEFAULT_ORCA_MAX_BUFFER = 10 * 1024 * 1024;

const DENIED_ORCHESTRATION = new Set([
  'send',
  'check',
  'reply',
  'ask',
  'worker-start',
  'worker-stop',
  'worker-abandon',
  'worker-release',
  'worker-retain',
  'worker-read',
  'task-create',
  'task-update',
  'dispatch',
  'run-create',
  'run-use',
  'reset',
  'gate-list',
  'inbox',
]);

const DENIED_WORKTREE = new Set(['create', 'set', 'rm']);
const DENIED_REFERENCE = new Set(['add', 'remove']);
const DENIED_REPO = new Set(['add', 'set', 'set-base-ref', 'search-refs']);

const ALLOWED_COMMAND_KEYS = new Set([
  'version',
  'status',
  'agent-context',
  'host:list',
  'worktree:list',
  'worktree:show',
  'worktree:current',
  'worktree:ps',
  'repo:list',
  'repo:show',
  'project:list',
  'reference:list',
  'reference:find',
  'orchestration:run-list',
  'orchestration:run-show',
  'orchestration:run-current',
  'orchestration:task-list',
  'orchestration:worker-list',
  'orchestration:worker-show',
  'orchestration:dispatch-show',
]);

export type OrcaAdapterOptions = {
  orcaPath?: string;
  timeoutMs?: number;
  maxBuffer?: number;
};

export type OrcaInvocationResult = {
  stdout: string;
  /** Sanitized; raw subprocess stderr is never exposed. */
  stderr: string;
  exitCode: number | null;
};


function orcaError(
  code: string,
  message: string,
  exitCode: number,
  hint?: string,
): CliError {
  return new CliError({ code, message, hint, exitCode });
}

export function resolveOrcaBinary(): string {
  const explicit = process.env['ORCA_TELEMETRY_ORCA'];
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  const cliCommand = process.env['ORCA_CLI_COMMAND'];
  if (cliCommand && cliCommand.length > 0) {
    return cliCommand;
  }
  return 'orca';
}

/**
 * Read a flag value from argv without treating the next flag as a value.
 */
export function readArgvFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) {
    return undefined;
  }
  const next = argv[idx + 1];
  if (next === undefined || next.startsWith('-')) {
    return '';
  }
  return next;
}

function requireArgvFlag(argv: string[], flag: string, commandLabel: string): void {
  const value = readArgvFlag(argv, flag);
  if (value === undefined) {
    throw orcaError(
      'orca_command_denied',
      `${commandLabel} requires ${flag}.`,
      EXIT_USAGE,
    );
  }
  if (value.length === 0) {
    throw orcaError(
      'orca_command_denied',
      `${flag} must have a non-empty value for ${commandLabel}.`,
      EXIT_USAGE,
    );
  }
}

function assertRequiredArgvSelectors(argv: string[], commandKey: string): void {
  switch (commandKey) {
    case 'worktree:show':
      requireArgvFlag(argv, '--worktree', 'worktree show');
      return;
    case 'repo:show':
      requireArgvFlag(argv, '--repo', 'repo show');
      return;
    case 'reference:list':
      requireArgvFlag(argv, '--worktree', 'reference list');
      return;
    case 'reference:find':
      requireArgvFlag(argv, '--query', 'reference find');
      return;
    case 'orchestration:run-show':
      requireArgvFlag(argv, '--id', 'orchestration run-show');
      return;
    case 'orchestration:task-list':
      requireArgvFlag(argv, '--run', 'orchestration task-list');
      return;
    case 'orchestration:worker-show':
      requireArgvFlag(argv, '--dispatch', 'orchestration worker-show');
      return;
    case 'orchestration:dispatch-show':
      requireArgvFlag(argv, '--task', 'orchestration dispatch-show');
      return;
    default:
      return;
  }
}

/** Raw subprocess stderr must not be exposed to callers or logs. */
export function sanitizeOrcaStderr(_stderr: string): string {
  return '';
}

function takesValue(flag: string): boolean {
  return (
    flag === '--worktree' ||
    flag === '--repo' ||
    flag === '--run' ||
    flag === '--id' ||
    flag === '--dispatch' ||
    flag === '--task' ||
    flag === '--query' ||
    flag === '--limit' ||
    flag === '--cursor' ||
    flag === '--terminal-state' ||
    flag === '--status' ||
    flag === '--pairing-code' ||
    flag === '--environment'
  );
}

/** Strip flag pairs; keep positionals and boolean flags for classification only. */
export function argvPositionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json' || arg === '--brief') {
      continue;
    }
    if (arg.startsWith('-')) {
      if (takesValue(arg)) {
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

function denyIfMutating(argv: string[]): void {
  const pos = argvPositionals(argv);
  if (pos.length >= 2 && pos[0] === 'orchestration') {
    const sub = pos[1] ?? '';
    if (sub.length > 0 && DENIED_ORCHESTRATION.has(sub)) {
      throw orcaError(
        'orca_command_denied',
        `Orca command 'orchestration ${sub}' is not allowlisted for read-only collection.`,
        EXIT_USAGE,
      );
    }
  }
  const worktreeSub = pos[1] ?? '';
  if (pos.length >= 2 && pos[0] === 'worktree' && worktreeSub.length > 0 && DENIED_WORKTREE.has(worktreeSub)) {
    throw orcaError(
      'orca_command_denied',
      `Orca command 'worktree ${worktreeSub}' mutates state and is blocked.`,
      EXIT_USAGE,
    );
  }
  const referenceSub = pos[1] ?? '';
  if (pos.length >= 2 && pos[0] === 'reference' && referenceSub.length > 0 && DENIED_REFERENCE.has(referenceSub)) {
    throw orcaError(
      'orca_command_denied',
      `Orca command 'reference ${referenceSub}' is not allowlisted.`,
      EXIT_USAGE,
    );
  }
  const repoSub = pos[1] ?? '';
  if (pos.length >= 2 && pos[0] === 'repo' && repoSub.length > 0 && DENIED_REPO.has(repoSub)) {
    throw orcaError(
      'orca_command_denied',
      `Orca command 'repo ${repoSub}' is not allowlisted.`,
      EXIT_USAGE,
    );
  }
  if (argv.includes('--preamble')) {
    throw orcaError(
      'orca_command_denied',
      'dispatch-show must not use --preamble in collectors.',
      EXIT_USAGE,
    );
  }
}

export function classifyOrcaArgv(argv: string[]): string {
  if (argv.length === 1 && argv[0] === '--version') {
    return 'version';
  }
  const pos = argvPositionals(argv);
  if (pos.length === 0) {
    throw orcaError(
      'orca_command_denied',
      'Empty Orca invocation is not allowlisted.',
      EXIT_USAGE,
    );
  }
  if (pos.length === 1) {
    if (pos[0] === 'status' || pos[0] === 'agent-context') {
      return pos[0];
    }
  }
  if (pos.length >= 2) {
    const key = `${pos[0]}:${pos[1]}`;
    return key;
  }
  throw orcaError(
    'orca_command_denied',
    `Unrecognized Orca command argv: ${pos.join(' ')}`,
    EXIT_USAGE,
  );
}

/**
 * Reject non-read-only argv before spawn (discovery § Orca allowlist).
 */
export function assertAllowlistedOrcaArgv(argv: string[]): void {
  denyIfMutating(argv);
  const key = classifyOrcaArgv(argv);
  if (!ALLOWED_COMMAND_KEYS.has(key)) {
    throw orcaError(
      'orca_command_denied',
      `Orca command '${key}' is not on the read-only allowlist.`,
      EXIT_USAGE,
      'See docs/discovery.md § Orca allowlist.',
    );
  }
  assertRequiredArgvSelectors(argv, key);
}

export function parseOrcaVersionText(stdout: string): string {
  const line = stdout.trim().split('\n')[0]?.trim() ?? '';
  const match = /^(\d+\.\d+\.\d+)/.exec(line);
  if (!match) {
    throw orcaError(
      'orca_schema_drift',
      'Could not parse orca --version output.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  const version = match[1];
  if (!version) {
    throw orcaError(
      'orca_schema_drift',
      'Could not parse orca --version output.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  return version;
}

export function assertSupportedOrcaVersion(version: string): void {
  if (version !== ORCA_VERIFIED_VERSION) {
    throw orcaError(
      'orca_version_unsupported',
      `Orca CLI version ${version} is not the verified build ${ORCA_VERIFIED_VERSION}.`,
      EXIT_SOURCE_UNAVAILABLE,
      `Use Orca desktop ${ORCA_VERIFIED_VERSION} as recorded in docs/discovery.md.`,
    );
  }
}

function resolveSpawnTarget(
  executable: string,
  args: string[],
): { command: string; argv: string[] } {
  if (executable.endsWith('.mjs') || executable.endsWith('.js')) {
    return { command: process.execPath, argv: [executable, ...args] };
  }
  return { command: executable, argv: args };
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxBuffer: number,
): Promise<OrcaInvocationResult & { spawnError?: NodeJS.ErrnoException }> {
  const target = resolveSpawnTarget(executable, args);
  return new Promise((resolve) => {
    const child = spawn(target.command, target.argv, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutEnded = false;
    let stderrEnded = false;
    let closed = false;
    let exitCode: number | null = null;
    let spawnError: NodeJS.ErrnoException | undefined;
    let settled = false;
    let timedOut = false;

    const finish = () => {
      if (settled || !stdoutEnded || !stderrEnded || !closed) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        spawnError: timedOut
          ? Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
          : spawnError,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        child.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stdout.on('end', () => {
      stdoutEnded = true;
      finish();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        child.kill('SIGTERM');
        return;
      }
      stderrChunks.push(chunk);
    });
    child.stderr.on('end', () => {
      stderrEnded = true;
      finish();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = err;
      closed = true;
      stdoutEnded = true;
      stderrEnded = true;
      finish();
    });
    child.on('close', (code) => {
      closed = true;
      exitCode = code;
      finish();
    });
  });
}

/**
 * Spawn Orca with allowlisted argv only (no shell).
 */
export async function invokeOrcaReadOnly(
  argv: string[],
  options: OrcaAdapterOptions = {},
): Promise<OrcaInvocationResult> {
  assertAllowlistedOrcaArgv(argv);
  const executable = options.orcaPath ?? resolveOrcaBinary();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ORCA_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_ORCA_MAX_BUFFER;

  const result = await runCommand(executable, argv, timeoutMs, maxBuffer);

  if (result.spawnError?.code === 'ENOENT') {
    throw orcaError(
      'orca_runtime_unavailable',
      'Orca CLI binary was not found.',
      EXIT_ENVIRONMENT,
      'Set ORCA_TELEMETRY_ORCA to the managed Orca binary path.',
    );
  }
  if (result.spawnError?.code === 'ETIMEDOUT') {
    throw orcaError(
      'orca_runtime_unavailable',
      'Orca CLI invocation timed out.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  if (result.spawnError) {
    throw orcaError(
      'orca_runtime_unavailable',
      'Failed to start Orca CLI.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  return {
    stdout: result.stdout,
    stderr: sanitizeOrcaStderr(result.stderr),
    exitCode: result.exitCode,
  };
}

export async function readOrcaVersion(
  options: OrcaAdapterOptions = {},
): Promise<string> {
  const result = await invokeOrcaReadOnly(['--version'], options);
  if (result.exitCode !== 0) {
    throw orcaError(
      'orca_runtime_unavailable',
      'orca --version failed.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  const version = parseOrcaVersionText(result.stdout);
  assertSupportedOrcaVersion(version);
  return version;
}

export function assertRuntimeReachable(statusJson: unknown): void {
  if (!statusJson || typeof statusJson !== 'object') {
    throw orcaError(
      'orca_schema_drift',
      'status JSON root is not an object.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  const record = statusJson as Record<string, unknown>;
  const result = record['result'];
  if (!result || typeof result !== 'object') {
    throw orcaError(
      'orca_schema_drift',
      'status JSON missing result.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  const runtime = (result as Record<string, unknown>)['runtime'];
  if (!runtime || typeof runtime !== 'object') {
    throw orcaError(
      'orca_schema_drift',
      'status JSON missing runtime.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  const reachable = (runtime as Record<string, unknown>)['reachable'];
  if (reachable !== true) {
    throw orcaError(
      'orca_runtime_unavailable',
      'Orca runtime is not reachable.',
      EXIT_SOURCE_UNAVAILABLE,
      'Start the Orca desktop app before orchestration queries.',
    );
  }
}
