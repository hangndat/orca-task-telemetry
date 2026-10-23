import { spawn } from 'node:child_process';
import {
  CliError,
  EXIT_ENVIRONMENT,
  EXIT_SOURCE_UNAVAILABLE,
  EXIT_USAGE,
} from '../errors.js';

export const CODEBURN_VERIFIED_VERSION = '0.9.27';
export const DEFAULT_CODEBURN_TIMEOUT_MS = 120_000;
export const DEFAULT_CODEBURN_MAX_BUFFER = 20 * 1024 * 1024;

const DENIED_SUBCOMMANDS = new Set([
  'export',
  'audit',
  'doctor',
  'login',
  'config',
]);

export type CodeburnAdapterOptions = {
  codeburnPath?: string;
  timeoutMs?: number;
  maxBuffer?: number;
};

export type CodeburnInvocationResult = {
  stdout: string;
  /** Always empty; raw subprocess stderr is never exposed. */
  stderr: string;
  exitCode: number | null;
};

/** Raw subprocess stderr must not be exposed to callers or error surfaces. */
export function discardCodeburnStderr(_stderr: string): string {
  return '';
}

function cbError(
  code: string,
  message: string,
  exitCode: number,
  hint?: string,
): CliError {
  return new CliError({ code, message, hint, exitCode });
}

export function resolveCodeburnBinary(): string {
  const fromEnv = process.env['ORCA_TELEMETRY_CODEBURN'];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return 'codeburn';
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

function assertSessionsArgv(argv: string[]): void {
  if (argv[0] !== 'sessions') {
    return;
  }
  if (!argv.includes('--format') || !argv.includes('json')) {
    throw cbError(
      'codeburn_command_denied',
      'sessions must use --format json.',
      EXIT_USAGE,
    );
  }
  const providerIdx = argv.indexOf('--provider');
  if (providerIdx < 0) {
    throw cbError(
      'codeburn_command_denied',
      'sessions requires --provider claude or codex.',
      EXIT_USAGE,
    );
  }
  const provider = argv[providerIdx + 1];
  if (provider !== 'claude' && provider !== 'codex') {
    throw cbError(
      'codeburn_command_denied',
      'Unsupported --provider for MVP sessions collection.',
      EXIT_USAGE,
    );
  }
}

/**
 * Reject non-read-only CodeBurn argv before spawn.
 */
export function assertAllowlistedCodeburnArgv(argv: string[]): void {
  if (argv.length === 1 && argv[0] === '--version') {
    return;
  }
  if (argv.length === 0) {
    throw cbError('codeburn_command_denied', 'Empty argv is not allowlisted.', EXIT_USAGE);
  }
  const head = argv[0] ?? '';
  if (head === '--help' || head === '-h') {
    throw cbError('codeburn_command_denied', 'Help is not invoked via collector.', EXIT_USAGE);
  }
  if (DENIED_SUBCOMMANDS.has(head)) {
    throw cbError(
      'codeburn_command_denied',
      `CodeBurn subcommand '${head}' is not allowlisted.`,
      EXIT_USAGE,
    );
  }
  if (head !== 'sessions') {
    throw cbError(
      'codeburn_command_denied',
      `CodeBurn argv must be --version or sessions; got '${head}'.`,
      EXIT_USAGE,
    );
  }
  assertSessionsArgv(argv);
}

export function parseCodeburnVersionText(stdout: string): string {
  const line = stdout.trim().split('\n')[0]?.trim() ?? '';
  const match = /^(\d+\.\d+\.\d+)/.exec(line);
  if (!match?.[1]) {
    throw cbError(
      'codeburn_schema_drift',
      'Could not parse codeburn --version output.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  return match[1];
}

export function assertSupportedCodeburnVersion(version: string): void {
  if (version !== CODEBURN_VERIFIED_VERSION) {
    throw cbError(
      'codeburn_version_unsupported',
      `CodeBurn version ${version} is not the verified ${CODEBURN_VERIFIED_VERSION} build.`,
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxBuffer: number,
): Promise<CodeburnInvocationResult & { spawnError?: NodeJS.ErrnoException }> {
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

export async function invokeCodeburn(
  argv: string[],
  options: CodeburnAdapterOptions = {},
): Promise<CodeburnInvocationResult> {
  assertAllowlistedCodeburnArgv(argv);
  const executable = options.codeburnPath ?? resolveCodeburnBinary();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODEBURN_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_CODEBURN_MAX_BUFFER;

  const result = await runCommand(executable, argv, timeoutMs, maxBuffer);

  if (result.spawnError?.code === 'ENOENT') {
    throw cbError(
      'codeburn_runtime_unavailable',
      'CodeBurn CLI was not found.',
      EXIT_ENVIRONMENT,
      'Set ORCA_TELEMETRY_CODEBURN or install codeburn@0.9.27.',
    );
  }
  if (result.spawnError?.code === 'ETIMEDOUT') {
    throw cbError(
      'codeburn_runtime_unavailable',
      'CodeBurn CLI invocation timed out.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  if (result.spawnError) {
    throw cbError(
      'codeburn_runtime_unavailable',
      'Failed to start CodeBurn CLI.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  return {
    stdout: result.stdout,
    stderr: discardCodeburnStderr(result.stderr),
    exitCode: result.exitCode,
  };
}

export async function readCodeburnVersion(
  options: CodeburnAdapterOptions = {},
): Promise<string> {
  const result = await invokeCodeburn(['--version'], options);
  if (result.exitCode !== 0) {
    throw cbError(
      'codeburn_runtime_unavailable',
      'codeburn --version failed.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  const version = parseCodeburnVersionText(result.stdout);
  assertSupportedCodeburnVersion(version);
  return version;
}

export function schemaDrift(path: string, detail: string): CliError {
  return cbError(
    'codeburn_schema_drift',
    `CodeBurn JSON invalid at ${path}: ${detail}`,
    EXIT_SOURCE_UNAVAILABLE,
  );
}

/**
 * Parse sessions stdout as JSON array (empty array allowed).
 */
export function parseSessionsJsonArray(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw schemaDrift('root', 'stdout is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw schemaDrift('root', 'expected JSON array from sessions --format json');
  }
  return parsed;
}
