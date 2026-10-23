import { spawn } from 'node:child_process';
import {
  CliError,
  EXIT_ENVIRONMENT,
  EXIT_SOURCE_UNAVAILABLE,
  usageError,
} from '../errors.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LEN = 300;

export type GithubGraphqlOptions = {
  /** Override `gh` executable (falls back to `ORCA_TELEMETRY_GH`, then `gh`). */
  ghPath?: string;
  timeoutMs?: number;
  maxBuffer?: number;
};

type GraphqlEnvelope = {
  data?: unknown;
  errors?: Array<{
    message?: string;
    type?: string;
    extensions?: { type?: string };
  }>;
};

type GhRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: NodeJS.ErrnoException;
};

function resolveGhPath(opts?: GithubGraphqlOptions): string {
  if (opts?.ghPath) {
    return opts.ghPath;
  }
  const fromEnv = process.env['ORCA_TELEMETRY_GH'];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return 'gh';
}

function truncateMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_LEN) {
    return message;
  }
  return `${message.slice(0, MAX_ERROR_MESSAGE_LEN - 1)}…`;
}

function githubCliError(
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

const READ_ONLY_REJECTED =
  'GraphQL mutations are not supported; only read-only queries are allowed.';

/** Strip comments and string literals so mutation/subscription tokens in strings are ignored. */
function stripGraphqlForReadOnlyCheck(query: string): string {
  let i = 0;
  let out = '';
  const len = query.length;

  if (query.charCodeAt(0) === 0xfeff) {
    i = 1;
  }

  while (i < len) {
    const ch = query[i];
    const next = query[i + 1];
    const next2 = query[i + 2];

    if (ch === '#') {
      while (i < len && query[i] !== '\n' && query[i] !== '\r') {
        i += 1;
      }
      continue;
    }

    if (ch === '"' && next === '"' && next2 === '"') {
      i += 3;
      while (i < len) {
        if (query[i] === '"' && query[i + 1] === '"' && query[i + 2] === '"') {
          i += 3;
          break;
        }
        if (query[i] === '\\' && i + 1 < len) {
          i += 2;
          continue;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      i += 1;
      while (i < len) {
        if (query[i] === '\\' && i + 1 < len) {
          i += 2;
          continue;
        }
        if (query[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function assertReadOnlyQuery(query: string): void {
  const stripped = stripGraphqlForReadOnlyCheck(query);
  if (/\b(mutation|subscription)\b/i.test(stripped)) {
    throw usageError(READ_ONLY_REJECTED);
  }
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

function isScopeError(text: string, errors?: GraphqlEnvelope['errors']): boolean {
  if (text.includes('read:project') || text.includes('insufficient_scopes')) {
    return true;
  }
  if (!errors) {
    return false;
  }
  return errors.some(
    (e) =>
      e.extensions?.type === 'INSUFFICIENT_SCOPES' ||
      (e.message ?? '').toLowerCase().includes('read:project'),
  );
}

function isAuthRequired(text: string): boolean {
  return (
    text.includes('not logged into') ||
    text.includes('gh auth login') ||
    text.includes('to authenticate') ||
    text.includes('authentication failed') ||
    text.includes('you are not logged into any github hosts')
  );
}

function isRateLimited(
  text: string,
  errors?: GraphqlEnvelope['errors'],
): boolean {
  if (text.includes('rate limit') || text.includes('rate_limit')) {
    return true;
  }
  return (
    errors?.some(
      (e) =>
        e.type === 'RATE_LIMITED' ||
        e.extensions?.type === 'RATE_LIMITED' ||
        (e.message ?? '').toLowerCase().includes('rate limit'),
    ) ?? false
  );
}

function extractResetAt(
  envelope: GraphqlEnvelope | null,
  raw: string,
): string | undefined {
  const data = envelope?.data;
  if (data && typeof data === 'object' && data !== null) {
    const rateLimit = (data as { rateLimit?: { resetAt?: string } }).rateLimit;
    if (rateLimit?.resetAt) {
      return rateLimit.resetAt;
    }
  }
  const match = raw.match(/resetAt["']?\s*[:=]\s*["']([^"']+)["']/i);
  return match?.[1];
}

function rateLimitHint(resetAt?: string): string {
  if (resetAt) {
    return `GitHub API rate limit exceeded. Resets at ${resetAt}.`;
  }
  return 'GitHub API rate limit exceeded.';
}

function mapGraphqlErrors(envelope: GraphqlEnvelope, raw: string): CliError {
  const text = combinedText('', raw);
  const errors = envelope.errors;

  if (isScopeError(text, errors)) {
    return githubCliError(
      'github_scope_missing',
      'GitHub token is missing the read:project scope.',
      EXIT_ENVIRONMENT,
      'gh auth refresh -s read:project',
    );
  }
  if (isRateLimited(text, errors)) {
    const resetAt = extractResetAt(envelope, raw);
    return githubCliError(
      'github_rate_limited',
      'GitHub API rate limit exceeded.',
      EXIT_SOURCE_UNAVAILABLE,
      rateLimitHint(resetAt),
    );
  }

  const first = redactGhSecrets(
    errors?.[0]?.message ?? 'GitHub GraphQL returned errors.',
  );
  return githubCliError(
    'github_bad_response',
    first,
    EXIT_SOURCE_UNAVAILABLE,
  );
}

function mapProcessFailure(result: GhRunResult): CliError {
  const spawnErr = result.spawnError;
  if (spawnErr?.code === 'ENOENT') {
    return githubCliError(
      'gh_not_found',
      'GitHub CLI (gh) was not found on PATH.',
      EXIT_ENVIRONMENT,
      'Install gh: https://cli.github.com/',
    );
  }

  const text = combinedText(result.stdout, result.stderr);

  if (result.signal === 'SIGTERM' || spawnErr?.code === 'ETIMEDOUT') {
    return githubCliError(
      'github_unavailable',
      'GitHub CLI request timed out or was interrupted.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  if (isScopeError(text)) {
    return githubCliError(
      'github_scope_missing',
      'GitHub token is missing the read:project scope.',
      EXIT_ENVIRONMENT,
      'gh auth refresh -s read:project',
    );
  }

  if (isAuthRequired(text)) {
    return githubCliError(
      'github_auth_required',
      'GitHub CLI is not authenticated.',
      EXIT_ENVIRONMENT,
      'gh auth login',
    );
  }

  if (isRateLimited(text)) {
    const resetAt = extractResetAt(null, `${result.stdout}${result.stderr}`);
    return githubCliError(
      'github_rate_limited',
      'GitHub API rate limit exceeded.',
      EXIT_SOURCE_UNAVAILABLE,
      rateLimitHint(resetAt),
    );
  }

  if (
    spawnErr?.code === 'ECONNRESET' ||
    spawnErr?.code === 'ENOTFOUND' ||
    spawnErr?.code === 'EAI_AGAIN'
  ) {
    return githubCliError(
      'github_unavailable',
      'Could not reach GitHub.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  const rawSnippet =
    (
      result.stderr ||
      result.stdout ||
      spawnErr?.message ||
      'gh failed'
    )
      .trim()
      .split('\n')[0] ?? '';
  const snippet = redactGhSecrets(rawSnippet);
  return githubCliError(
    'github_bad_response',
    snippet || 'GitHub CLI returned an error.',
    EXIT_SOURCE_UNAVAILABLE,
  );
}

function runGhGraphql(
  ghExecutable: string,
  body: string,
  timeoutMs: number,
  maxBuffer: number,
): Promise<GhRunResult> {
  return new Promise((resolve) => {
    const child = spawn(ghExecutable, ['api', 'graphql', '--input', '-'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    let overBuffer = false;

    const tryFinish = () => {
      if (settled || !stdoutEnded || !stderrEnded || !closed) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        spawnError: timedOut
          ? Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
          : spawnError,
      });
    };

    const killForLimit = () => {
      if (!overBuffer) {
        overBuffer = true;
        child.kill('SIGTERM');
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        killForLimit();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stdout.on('end', () => {
      stdoutEnded = true;
      tryFinish();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        killForLimit();
        return;
      }
      stderrChunks.push(chunk);
    });
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

    child.stdin.write(body);
    child.stdin.end();
  });
}

/**
 * Run a read-only GitHub GraphQL query via `gh api graphql --input -`.
 * Auth and tokens are handled entirely by the GitHub CLI.
 */
export async function graphql<TData>(
  query: string,
  variables: Record<string, unknown> = {},
  opts?: GithubGraphqlOptions,
): Promise<TData> {
  assertReadOnlyQuery(query);

  const ghExecutable = resolveGhPath(opts);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const body = JSON.stringify({ query, variables });

  const result = await runGhGraphql(ghExecutable, body, timeoutMs, maxBuffer);

  if (result.spawnError && result.spawnError.code === 'ENOENT') {
    throw mapProcessFailure(result);
  }

  let envelope: GraphqlEnvelope | null = null;
  const rawOut = result.stdout.trim();
  if (rawOut.length > 0) {
    try {
      envelope = JSON.parse(rawOut) as GraphqlEnvelope;
    } catch {
      throw githubCliError(
        'github_bad_response',
        'GitHub CLI returned invalid JSON.',
        EXIT_SOURCE_UNAVAILABLE,
      );
    }
  }

  if (result.exitCode !== 0 || result.signal) {
    if (envelope?.errors?.length) {
      throw mapGraphqlErrors(envelope, rawOut);
    }
    throw mapProcessFailure(result);
  }

  if (!envelope) {
    throw githubCliError(
      'github_bad_response',
      'GitHub CLI returned an empty response.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  if (envelope.errors && envelope.errors.length > 0) {
    throw mapGraphqlErrors(envelope, rawOut);
  }

  if (envelope.data === undefined) {
    throw githubCliError(
      'github_bad_response',
      'GitHub GraphQL response did not include data.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  return envelope.data as TData;
}
