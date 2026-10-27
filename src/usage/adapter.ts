import { spawn } from 'node:child_process';
import {
  CliError,
  EXIT_ENVIRONMENT,
  EXIT_SOURCE_UNAVAILABLE,
  EXIT_USAGE,
} from '../errors.js';

export const AGENT_TOP_VERIFIED_VERSION = '0.27.1';
export const DEFAULT_AGENT_TOP_TIMEOUT_MS = 120_000;
export const DEFAULT_AGENT_TOP_MAX_BUFFER = 20 * 1024 * 1024;

/** Allowlisted read-only query — documented counted_sessions columns only. */
export const COUNTED_SESSIONS_QUERY =
  "SELECT harness, session_id, model, project, input, output, cache_read, cache_write_5m, cache_write_1h, cache_write_unsplit, cost_usd, unpriced_tokens, parent_session_id FROM counted_sessions WHERE harness IN ('claude', 'codex', 'cursor')";

const DENIED_SUBCOMMANDS = new Set([
  'sync',
  'fails',
  'report',
  'live',
]);

export type AgentTopAdapterOptions = {
  agentTopPath?: string;
  timeoutMs?: number;
  maxBuffer?: number;
};

export type AgentTopInvocationResult = {
  stdout: string;
  /** Always empty; raw subprocess stderr is never exposed. */
  stderr: string;
  exitCode: number | null;
};

export function discardAgentTopStderr(_stderr: string): string {
  return '';
}

function atError(
  code: string,
  message: string,
  exitCode: number,
  hint?: string,
): CliError {
  return new CliError({ code, message, hint, exitCode });
}

export function resolveAgentTopBinary(): string {
  const fromEnv = process.env['ORCA_TELEMETRY_AGENT_TOP'];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return 'agent-top';
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

/**
 * Reject non-read-only agent-top argv before spawn.
 */
export function assertAllowlistedAgentTopArgv(argv: string[]): void {
  if (argv.length === 1 && argv[0] === '--version') {
    return;
  }
  if (argv.length === 0) {
    throw atError('agent_top_command_denied', 'Empty argv is not allowlisted.', EXIT_USAGE);
  }
  const head = argv[0] ?? '';
  if (head === '--help' || head === '-h') {
    throw atError('agent_top_command_denied', 'Help is not invoked via collector.', EXIT_USAGE);
  }
  if (DENIED_SUBCOMMANDS.has(head)) {
    throw atError(
      'agent_top_command_denied',
      `agent-top subcommand '${head}' is not allowlisted.`,
      EXIT_USAGE,
    );
  }
  if (head !== 'sql') {
    throw atError(
      'agent_top_command_denied',
      `agent-top argv must be --version or sql --json; got '${head}'.`,
      EXIT_USAGE,
    );
  }
  if (argv.length !== 3 || argv[1] !== '--json' || argv[2] !== COUNTED_SESSIONS_QUERY) {
    throw atError(
      'agent_top_command_denied',
      'sql must use --json and the allowlisted counted_sessions query.',
      EXIT_USAGE,
    );
  }
}

export function parseAgentTopVersionText(stdout: string): string {
  const line = stdout.trim().split('\n')[0]?.trim() ?? '';
  const match = /(\d+\.\d+\.\d+)/.exec(line);
  if (!match?.[1]) {
    throw atError(
      'agent_top_schema_drift',
      'Could not parse agent-top --version output.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  return match[1];
}

export function assertSupportedAgentTopVersion(version: string): void {
  if (version !== AGENT_TOP_VERIFIED_VERSION) {
    throw atError(
      'agent_top_version_unsupported',
      `agent-top version ${version} is not the verified ${AGENT_TOP_VERIFIED_VERSION} build.`,
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxBuffer: number,
): Promise<AgentTopInvocationResult & { spawnError?: NodeJS.ErrnoException }> {
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

export async function invokeAgentTop(
  argv: string[],
  options: AgentTopAdapterOptions = {},
): Promise<AgentTopInvocationResult> {
  assertAllowlistedAgentTopArgv(argv);
  const executable = options.agentTopPath ?? resolveAgentTopBinary();
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TOP_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_AGENT_TOP_MAX_BUFFER;

  const result = await runCommand(executable, argv, timeoutMs, maxBuffer);

  if (result.spawnError?.code === 'ENOENT') {
    throw atError(
      'agent_top_runtime_unavailable',
      'agent-top CLI was not found.',
      EXIT_ENVIRONMENT,
      'Set ORCA_TELEMETRY_AGENT_TOP or install agent-top 0.27.1.',
    );
  }
  if (result.spawnError?.code === 'ETIMEDOUT') {
    throw atError(
      'agent_top_runtime_unavailable',
      'agent-top CLI invocation timed out.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  if (result.spawnError) {
    throw atError(
      'agent_top_runtime_unavailable',
      'Failed to start agent-top CLI.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  return {
    stdout: result.stdout,
    stderr: discardAgentTopStderr(result.stderr),
    exitCode: result.exitCode,
  };
}

export async function readAgentTopVersion(
  options: AgentTopAdapterOptions = {},
): Promise<string> {
  const result = await invokeAgentTop(['--version'], options);
  if (result.exitCode !== 0) {
    throw atError(
      'agent_top_runtime_unavailable',
      'agent-top --version failed.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  const version = parseAgentTopVersionText(result.stdout);
  assertSupportedAgentTopVersion(version);
  return version;
}

export function schemaDrift(path: string, detail: string): CliError {
  return atError(
    'agent_top_schema_drift',
    `agent-top JSON invalid at ${path}: ${detail}`,
    EXIT_SOURCE_UNAVAILABLE,
  );
}

/** Parse sql --json stdout as a JSON array (empty array allowed). */
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
    throw schemaDrift('root', 'expected JSON array from sql --json');
  }
  return parsed;
}
