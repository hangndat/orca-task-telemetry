import { spawn } from 'node:child_process';
import {
  CliError,
  EXIT_ENVIRONMENT,
  EXIT_SOURCE_UNAVAILABLE,
  EXIT_USAGE,
} from './errors.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 1_024 * 1_024;

/** Verified GitHub repository identity from `gh repo view --json`. */
export type GitHubRepository = {
  id: string;
  nameWithOwner: string;
  url: string;
};

export type ResolvedRepository = {
  gitRoot: string;
  remoteName: string;
  github: GitHubRepository;
};

export type ResolveRepositoryOptions = {
  gitPath?: string;
  ghPath?: string;
  timeoutMs?: number;
  maxBuffer?: number;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: NodeJS.ErrnoException;
};

type GithubRemoteCandidate = {
  name: string;
  owner: string;
  repo: string;
};

function resolveGitPath(opts?: ResolveRepositoryOptions): string {
  return opts?.gitPath ?? 'git';
}

function resolveGhPath(opts?: ResolveRepositoryOptions): string {
  if (opts?.ghPath) {
    return opts.ghPath;
  }
  const fromEnv = process.env['ORCA_TELEMETRY_GH'];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return 'gh';
}

function repoCliError(
  code: string,
  message: string,
  exitCode: number,
  hint?: string,
): CliError {
  return new CliError({ code, message, hint, exitCode });
}

function redactSecrets(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '<REDACTED>')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '<REDACTED>')
    .replace(/Bearer\s+\S+/g, 'Bearer <REDACTED>');
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxBuffer: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
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
 * Parse a git remote URL into GitHub `owner` and `repo`, or `null` if not github.com.
 */
export function parseGithubRemoteUrl(
  remoteUrl: string,
): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  const https = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(
    trimmed,
  );
  if (https) {
    const owner = https[1];
    const repo = https[2];
    if (owner && repo) {
      return { owner, repo };
    }
  }

  const scp = /^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) {
    const owner = scp[1];
    const repo = scp[2];
    if (owner && repo) {
      return { owner, repo };
    }
  }

  const sshUrl =
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (sshUrl) {
    const owner = sshUrl[1];
    const repo = sshUrl[2];
    if (owner && repo) {
      return { owner, repo };
    }
  }

  return null;
}

async function gitTopLevel(
  cwd: string,
  opts?: ResolveRepositoryOptions,
): Promise<string> {
  const git = resolveGitPath(opts);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const result = await runCommand(
    git,
    ['-C', cwd, 'rev-parse', '--show-toplevel'],
    timeoutMs,
    maxBuffer,
  );

  if (result.spawnError?.code === 'ENOENT') {
    throw repoCliError(
      'git_not_found',
      'git was not found on PATH.',
      EXIT_ENVIRONMENT,
      'Install git and ensure it is on PATH.',
    );
  }

  if (result.exitCode !== 0 || result.signal) {
    throw repoCliError(
      'not_a_git_repository',
      'Directory is not inside a Git repository.',
      EXIT_ENVIRONMENT,
      'Run from a clone with a GitHub remote, or pass a repository directory.',
    );
  }

  const root = result.stdout.trim();
  if (root.length === 0) {
    throw repoCliError(
      'not_a_git_repository',
      'Git did not return a repository root.',
      EXIT_ENVIRONMENT,
    );
  }
  return root;
}

async function listGithubRemotes(
  gitRoot: string,
  opts?: ResolveRepositoryOptions,
): Promise<GithubRemoteCandidate[]> {
  const git = resolveGitPath(opts);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const result = await runCommand(
    git,
    ['-C', gitRoot, 'remote', '-v'],
    timeoutMs,
    maxBuffer,
  );

  if (result.exitCode !== 0) {
    throw repoCliError(
      'git_remote_error',
      'Could not list git remotes.',
      EXIT_SOURCE_UNAVAILABLE,
      redactSecrets(result.stderr.trim().split('\n')[0] ?? ''),
    );
  }

  const byName = new Map<string, GithubRemoteCandidate>();
  for (const line of result.stdout.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line.trim());
    if (!match) {
      continue;
    }
    const name = match[1];
    const url = match[2];
    if (!name || !url || byName.has(name)) {
      continue;
    }
    const parsed = parseGithubRemoteUrl(url);
    if (parsed) {
      byName.set(name, { name, owner: parsed.owner, repo: parsed.repo });
    }
  }
  return [...byName.values()];
}

function selectRemote(
  remotes: GithubRemoteCandidate[],
  remoteName?: string,
): GithubRemoteCandidate {
  if (remotes.length === 0) {
    throw repoCliError(
      'no_github_remote',
      'No GitHub remote was found in this repository.',
      EXIT_ENVIRONMENT,
      'Add a remote pointing at https://github.com/owner/repo or git@github.com:owner/repo.git.',
    );
  }

  if (remoteName) {
    const found = remotes.find((r) => r.name === remoteName);
    if (!found) {
      const names = remotes.map((r) => r.name).join(', ');
      throw repoCliError(
        'unknown_git_remote',
        `Git remote '${remoteName}' is not a GitHub remote.`,
        EXIT_USAGE,
        `Available GitHub remotes: ${names}.`,
      );
    }
    return found;
  }

  if (remotes.length === 1) {
    const only = remotes[0];
    if (!only) {
      throw repoCliError(
        'no_github_remote',
        'No GitHub remote was found in this repository.',
        EXIT_ENVIRONMENT,
      );
    }
    return only;
  }

  const names = remotes.map((r) => r.name).join(', ');
  throw repoCliError(
    'ambiguous_github_remote',
    `Multiple GitHub remotes found (${names}).`,
    EXIT_USAGE,
    'Pass the remote name to select (for example origin).',
  );
}

function parseGhRepoView(body: string): GitHubRepository {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw repoCliError(
      'github_repo_bad_response',
      'gh repo view returned invalid JSON.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw repoCliError(
      'github_repo_bad_response',
      'gh repo view JSON was not an object.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  const record = parsed as Record<string, unknown>;
  const id = record['id'];
  const nameWithOwner = record['nameWithOwner'];
  const url = record['url'];

  if (typeof id !== 'string' || id.length === 0) {
    throw repoCliError(
      'github_repo_bad_response',
      'gh repo view JSON missing string id.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  if (typeof nameWithOwner !== 'string' || nameWithOwner.length === 0) {
    throw repoCliError(
      'github_repo_bad_response',
      'gh repo view JSON missing string nameWithOwner.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  if (typeof url !== 'string' || url.length === 0) {
    throw repoCliError(
      'github_repo_bad_response',
      'gh repo view JSON missing string url.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  return { id, nameWithOwner, url };
}

async function verifyWithGh(
  owner: string,
  repo: string,
  opts?: ResolveRepositoryOptions,
): Promise<GitHubRepository> {
  const gh = resolveGhPath(opts);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const slug = `${owner}/${repo}`;
  const result = await runCommand(
    gh,
    ['repo', 'view', slug, '--json', 'id,nameWithOwner,url'],
    timeoutMs,
    maxBuffer,
  );

  if (result.spawnError?.code === 'ENOENT') {
    throw repoCliError(
      'gh_not_found',
      'GitHub CLI (gh) was not found on PATH.',
      EXIT_ENVIRONMENT,
      'Install gh: https://cli.github.com/',
    );
  }

  if (result.exitCode !== 0 || result.signal) {
    const snippet = redactSecrets(
      (result.stderr || result.stdout).trim().split('\n')[0] ?? 'gh repo view failed',
    );
    throw repoCliError(
      'github_repo_bad_response',
      snippet,
      EXIT_SOURCE_UNAVAILABLE,
    );
  }

  return parseGhRepoView(result.stdout);
}

/**
 * Resolve `cwd` to a verified {@link GitHubRepository} using git remotes and `gh repo view`.
 */
export async function resolveRepository(
  cwd: string,
  remoteName?: string,
  opts?: ResolveRepositoryOptions,
): Promise<ResolvedRepository> {
  const gitRoot = await gitTopLevel(cwd, opts);
  const remotes = await listGithubRemotes(gitRoot, opts);
  const selected = selectRemote(remotes, remoteName);
  const github = await verifyWithGh(selected.owner, selected.repo, opts);

  return {
    gitRoot,
    remoteName: selected.name,
    github,
  };
}
