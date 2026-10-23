import { spawn } from 'node:child_process';
import {
  CliError,
  EXIT_ENVIRONMENT,
  EXIT_SOURCE_UNAVAILABLE,
  EXIT_USAGE,
  usageError,
} from '../errors.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 1_024 * 1_024;
const MAX_ERROR_MESSAGE_LEN = 300;

const FORBIDDEN_ITEM_EDIT_FLAGS = new Set([
  '--clear',
  '--text',
  '--field',
  '--owner',
  '--url',
  '--format',
  '--body',
  '--title',
  '--date',
  '--value',
  '--single-select-option-id',
  '--iteration-id',
]);

export type GhProjectItemEditOptions = {
  /** Override `gh` executable (falls back to `ORCA_TELEMETRY_GH`, then `gh`). */
  ghPath?: string;
  timeoutMs?: number;
  maxBuffer?: number;
};

export type SetProjectItemNumberInput = {
  projectItemId: string;
  fieldId: string;
  projectId: string;
  number: number;
};

type GhRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: NodeJS.ErrnoException;
};

function resolveGhPath(opts?: GhProjectItemEditOptions): string {
  if (opts?.ghPath) {
    return opts.ghPath;
  }
  const fromEnv = process.env['ORCA_TELEMETRY_GH'];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return 'gh';
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

function truncateMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_LEN) {
    return message;
  }
  return `${message.slice(0, MAX_ERROR_MESSAGE_LEN - 1)}…`;
}

function ghApplyError(
  code: string,
  message: string,
  exitCode: number,
  hint?: string,
): CliError {
  return new CliError({
    code,
    message: truncateMessage(message),
    hint,
    exitCode,
  });
}

function redactGhSecrets(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '<REDACTED>')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '<REDACTED>')
    .replace(/Bearer\s+\S+/g, 'Bearer <REDACTED>');
}

function combinedText(stdout: string, stderr: string): string {
  return `${stderr}\n${stdout}`.toLowerCase();
}

function isScopeError(text: string): boolean {
  return (
    text.includes('insufficient_scopes') ||
    text.includes('read:project') ||
    (text.includes('project') && text.includes('scope'))
  );
}

function isAuthRequired(text: string): boolean {
  return (
    text.includes('auth login') ||
    text.includes('not logged') ||
    text.includes('authentication') ||
    text.includes('401')
  );
}

function requireNonEmptyId(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw usageError(`${label} is required.`);
  }
  return trimmed;
}

function formatGhNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw usageError('number must be a finite value.');
  }
  return String(value);
}

/**
 * Build argv for `gh project item-edit` with node IDs and a single NUMBER field.
 * Does not include project number, owner, or name-based field selectors.
 */
export function buildProjectItemEditNumberArgv(
  input: SetProjectItemNumberInput,
): string[] {
  const projectItemId = requireNonEmptyId('projectItemId', input.projectItemId);
  const fieldId = requireNonEmptyId('fieldId', input.fieldId);
  const projectId = requireNonEmptyId('projectId', input.projectId);
  const numberText = formatGhNumber(input.number);

  const argv = [
    'project',
    'item-edit',
    '--id',
    projectItemId,
    '--field-id',
    fieldId,
    '--project-id',
    projectId,
    '--number',
    numberText,
  ];

  for (const flag of argv) {
    if (FORBIDDEN_ITEM_EDIT_FLAGS.has(flag)) {
      throw usageError(`Forbidden gh project item-edit flag: ${flag}.`);
    }
  }

  return argv;
}

function mapProcessFailure(result: GhRunResult): CliError {
  const spawnErr = result.spawnError;
  if (spawnErr?.code === 'ENOENT') {
    return ghApplyError(
      'gh_not_found',
      'GitHub CLI (gh) was not found on PATH.',
      EXIT_ENVIRONMENT,
      'Install gh: https://cli.github.com/',
    );
  }

  const text = combinedText(result.stdout, result.stderr);

  if (result.signal === 'SIGTERM' || spawnErr?.code === 'ETIMEDOUT') {
    return ghApplyError(
      'github_unavailable',
      'GitHub CLI request timed out or was interrupted.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  if (isScopeError(text)) {
    return ghApplyError(
      'github_scope_missing',
      'GitHub token is missing the project scope required for item-edit.',
      EXIT_ENVIRONMENT,
      'gh auth refresh -s project',
    );
  }

  if (isAuthRequired(text)) {
    return ghApplyError(
      'github_auth_required',
      'GitHub CLI is not authenticated.',
      EXIT_ENVIRONMENT,
      'gh auth login',
    );
  }

  if (
    spawnErr?.code === 'ECONNRESET' ||
    spawnErr?.code === 'ENOTFOUND' ||
    spawnErr?.code === 'EAI_AGAIN'
  ) {
    return ghApplyError(
      'github_unavailable',
      'Could not reach GitHub.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  const rawSnippet =
    (result.stderr || result.stdout || spawnErr?.message || 'gh project item-edit failed')
      .trim()
      .split('\n')[0] ?? '';
  const snippet = redactGhSecrets(rawSnippet);
  return ghApplyError(
    'github_apply_failed',
    snippet || 'GitHub project item-edit failed.',
    EXIT_SOURCE_UNAVAILABLE,
  );
}

function runGh(
  ghExecutable: string,
  args: string[],
  timeoutMs: number,
  maxBuffer: number,
): Promise<GhRunResult> {
  const target = resolveSpawnTarget(ghExecutable, args);
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
    let signal: NodeJS.Signals | null = null;
    let spawnError: NodeJS.ErrnoException | undefined;
    let settled = false;
    let timedOut = false;

    const tryFinish = () => {
      if (settled || !stdoutEnded || !stderrEnded || !closed) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        signal,
        spawnError: timedOut
          ? Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
          : spawnError,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    const onStdout = (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        child.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    };
    const onStderr = (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        child.kill('SIGTERM');
        return;
      }
      stderrChunks.push(chunk);
    };

    child.stdout.on('data', onStdout);
    child.stdout.on('end', () => {
      stdoutEnded = true;
      tryFinish();
    });
    child.stderr.on('data', onStderr);
    child.stderr.on('end', () => {
      stderrEnded = true;
      tryFinish();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = err;
      closed = true;
      stdoutEnded = true;
      stderrEnded = true;
      tryFinish();
    });

    child.on('close', (code, sig) => {
      closed = true;
      exitCode = code;
      signal = sig;
      tryFinish();
    });
  });
}

/**
 * Set a single NUMBER custom field on a project item via `gh project item-edit`.
 * One subprocess invocation per call; no retry or concurrency inside the adapter.
 */
export async function setProjectItemNumberField(
  input: SetProjectItemNumberInput,
  options: GhProjectItemEditOptions = {},
): Promise<void> {
  const argv = buildProjectItemEditNumberArgv(input);
  const ghExecutable = resolveGhPath(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  const result = await runGh(ghExecutable, argv, timeoutMs, maxBuffer);

  if (result.spawnError && result.spawnError.code !== 'ETIMEDOUT') {
    throw mapProcessFailure(result);
  }

  if (result.exitCode !== 0) {
    throw mapProcessFailure(result);
  }
}
