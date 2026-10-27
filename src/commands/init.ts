import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, saveConfig } from '../config.js';
import { discoverProjects, type DiscoveredProject } from '../github/projects.js';
import { upsertProfile } from '../profiles.js';
import { usageError } from '../errors.js';
import { createDefaultPathEnv, resolveAppPaths } from '../paths.js';
import { resolveRepository, type ResolveRepositoryOptions } from '../repo.js';
import type { RouteResult } from './router.js';

export type InitCommandOptions = {
  json: boolean;
  cwd: string;
  ghPath?: string;
  gitPath?: string;
  /** When set, overrides TTY detection for interactive selection. */
  isInteractive?: boolean;
  /** Test hook: choose project by list index without readline. */
  promptSelectProject?: (projects: DiscoveredProject[]) => Promise<number>;
  now?: () => string;
};

export type ParsedProjectUrl = {
  kind?: 'user' | 'organization';
  login: string;
  number: number;
};

/** users|orgs/<login>/projects/<n> with optional /views/<n> and trailing slash. */
const USER_OR_ORG_PROJECT_PATH =
  /^(?:\/)?(users|orgs)\/([^/]+)\/projects\/(\d+)(?:\/views\/\d+)?\/?$/i;
/** <login>/projects/<n> with optional /views/<n> (kind inferred from discovery). */
const OWNER_PROJECT_PATH =
  /^(?:\/)?([^/]+)\/projects\/(\d+)(?:\/views\/\d+)?\/?$/i;

function parseInitArgs(rest: string[]): { remote?: string; project?: string } {
  try {
    const parsed = parseArgs({
      args: rest,
      options: {
        remote: { type: 'string' },
        project: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length > 0) {
      throw usageError(
        'init command does not take positional arguments.',
        'Usage: orca-telemetry init [--project <number|url>] [--remote <name>] [--json]',
      );
    }
    const remote = parsed.values.remote;
    if (remote !== undefined && remote.length === 0) {
      throw usageError('--remote requires a value.', 'Example: --remote origin');
    }
    const project = parsed.values.project;
    if (project !== undefined && project.length === 0) {
      throw usageError('--project requires a value.', 'Example: --project 4 or --project <project-url>');
    }
    return { remote, project };
  } catch (err) {
    if (err instanceof Error && err.name === 'TypeError') {
      throw usageError(err.message, 'Usage: orca-telemetry init [--project <number|url>] [--remote <name>]');
    }
    throw err;
  }
}

function projectPathFromUrl(specifier: string): string {
  let parsed: URL;
  try {
    parsed = new URL(specifier);
  } catch {
    throw usageError(
      'Project URL is not valid.',
      'Use a github.com users/.../projects/N or orgs/.../projects/N URL.',
    );
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'github.com') {
    throw usageError(
      'Project URL must be on github.com.',
      'Use a URL like https://github.com/users/owner/projects/4',
    );
  }
  return parsed.pathname;
}

function parsedFromProjectPath(pathname: string): ParsedProjectUrl | null {
  const path = pathname.replace(/\/+$/, '');
  const userOrOrg = USER_OR_ORG_PROJECT_PATH.exec(path);
  if (userOrOrg) {
    const kindRaw = userOrOrg[1]?.toLowerCase();
    const login = userOrOrg[2];
    const number = Number.parseInt(userOrOrg[3] ?? '', 10);
    if (!login || !Number.isInteger(number) || number < 1) {
      throw usageError('Project URL path is invalid.', 'Project number must be a positive integer.');
    }
    const kind: 'user' | 'organization' = kindRaw === 'orgs' ? 'organization' : 'user';
    return { kind, login, number };
  }
  const ownerPath = OWNER_PROJECT_PATH.exec(path);
  if (ownerPath) {
    const login = ownerPath[1];
    const number = Number.parseInt(ownerPath[2] ?? '', 10);
    if (!login || !Number.isInteger(number) || number < 1) {
      throw usageError('Project path is invalid.', 'Project number must be a positive integer.');
    }
    return { login, number };
  }
  return null;
}

/**
 * Parse a GitHub Projects V2 specifier: board URL, users|orgs/.../projects/N, or owner/projects/N.
 * Query strings and optional /views/N are ignored. Returns null for a bare project number.
 */
export function parseProjectUrl(specifier: string): ParsedProjectUrl | null {
  const trimmed = specifier.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let pathname: string;
  let fromAbsoluteUrl = false;
  if (/^https?:\/\//i.test(trimmed)) {
    fromAbsoluteUrl = true;
    pathname = projectPathFromUrl(trimmed);
  } else {
    const withoutHost = trimmed.replace(/^(?:www\.)?github\.com\//i, '');
    pathname = withoutHost.startsWith('/') ? withoutHost : `/${withoutHost}`;
  }

  const parsed = parsedFromProjectPath(pathname);
  if (parsed) {
    return parsed;
  }
  if (fromAbsoluteUrl) {
    throw usageError(
      'Project URL path is not a GitHub Project URL.',
      'Expected .../users/<owner>/projects/<n> or .../orgs/<owner>/projects/<n> (optional /views/<n>).',
    );
  }
  return null;
}

function projectMatchesUrl(project: DiscoveredProject, parsed: ParsedProjectUrl): boolean {
  if (project.number !== parsed.number || project.owner.login !== parsed.login) {
    return false;
  }
  if (parsed.kind !== undefined && project.owner.kind !== parsed.kind) {
    return false;
  }
  return true;
}

function selectByNumber(
  projects: DiscoveredProject[],
  number: number,
): DiscoveredProject {
  if (!Number.isInteger(number) || number < 1) {
    throw usageError(
      'Project number must be a positive integer.',
      'Use --project <number> or a full project URL.',
    );
  }
  const matches = projects.filter((p) => p.number === number);
  if (matches.length === 0) {
    throw usageError(
      `No discovered project with number ${number} for this repository.`,
      'Run orca-telemetry projects to list available projects, or pass a full project URL.',
    );
  }
  if (matches.length > 1) {
    throw usageError(
      `Project number ${number} is ambiguous (${matches.length} matches).`,
      'Pass the full project URL with --project to disambiguate.',
    );
  }
  return matches[0]!;
}

function selectBySpecifier(
  projects: DiscoveredProject[],
  specifier: string,
): DiscoveredProject {
  const trimmed = specifier.trim();
  const urlParsed = parseProjectUrl(trimmed);
  if (urlParsed) {
    const matches = projects.filter((p) => projectMatchesUrl(p, urlParsed));
    if (matches.length === 0) {
      throw usageError(
        'The project URL does not match any discovered project for this repository.',
        'Run orca-telemetry projects to list available projects.',
      );
    }
    if (matches.length > 1) {
      throw usageError(
        'The project URL matched multiple discovered projects.',
        'Contact support if this persists; try re-running init with --project <url>.',
      );
    }
    return matches[0]!;
  }

  const asNumber = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(asNumber) || String(asNumber) !== trimmed) {
    throw usageError(
      '--project must be a project number or a github.com project URL.',
      'Example: --project 4, --project users/you/projects/4, or a github.com project URL (optional /views/N).',
    );
  }
  return selectByNumber(projects, asNumber);
}

async function promptInteractiveSelection(
  projects: DiscoveredProject[],
): Promise<number> {
  const lines = [
    'Select a GitHub Project for this repository:',
    '',
  ];
  projects.forEach((p, index) => {
    const closed = p.closed ? ' (closed)' : '';
    lines.push(
      `  ${index + 1}. #${p.number} ${p.title}${closed} — ${p.url}`,
    );
  });
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question('Enter number (1-based): ');
    const choice = Number.parseInt(answer.trim(), 10);
    if (!Number.isInteger(choice) || choice < 1 || choice > projects.length) {
      throw usageError(
        'Selection is out of range.',
        `Enter a number between 1 and ${projects.length}.`,
      );
    }
    return choice - 1;
  } finally {
    rl.close();
  }
}

async function resolveProjectSelection(
  projects: DiscoveredProject[],
  projectFlag: string | undefined,
  options: InitCommandOptions,
): Promise<DiscoveredProject> {
  if (projectFlag !== undefined) {
    return selectBySpecifier(projects, projectFlag);
  }

  const interactive =
    options.promptSelectProject !== undefined
      ? true
      : (options.isInteractive ?? input.isTTY);

  if (!interactive) {
    throw usageError(
      'init requires --project when not attached to an interactive terminal.',
      'Use: orca-telemetry init --project <number|url> or run from a TTY.',
    );
  }

  if (options.promptSelectProject) {
    const index = await options.promptSelectProject(projects);
    if (!Number.isInteger(index) || index < 0 || index >= projects.length) {
      throw usageError('Interactive selection index is out of range.');
    }
    return projects[index]!;
  }

  const index = await promptInteractiveSelection(projects);
  return projects[index]!;
}

function canonicalAppHomePath(gitRoot: string, appHome: string): string {
  const home = path.resolve(appHome);
  try {
    return realpathSync.native(home);
  } catch {
    const parent = path.dirname(home);
    const base = path.basename(home);
    try {
      return path.join(realpathSync.native(parent), base);
    } catch {
      return home;
    }
  }
}

function assertAppHomeOutsideGitRoot(gitRoot: string, appHome: string): void {
  const root = realpathSync.native(gitRoot);
  const home = canonicalAppHomePath(gitRoot, appHome);
  if (home === root || home.startsWith(`${root}${path.sep}`)) {
    throw usageError(
      'ORCA_TELEMETRY_HOME must not be inside the target Git repository.',
      'Set ORCA_TELEMETRY_HOME to a user data directory outside the repository working tree.',
    );
  }
}

function formatInitTable(
  repository: { nameWithOwner: string },
  profile: { project: { number: number; title?: string; url: string } },
): string {
  return [
    `Repository: ${repository.nameWithOwner}`,
    `Project: #${profile.project.number} ${profile.project.url}`,
    'Profile saved.',
    '',
  ].join('\n');
}

export async function runInit(
  rest: string[],
  options: InitCommandOptions,
): Promise<RouteResult> {
  const { remote, project: projectFlag } = parseInitArgs(rest);

  if (options.json && projectFlag === undefined) {
    throw usageError(
      'init --json requires --project.',
      'Use: orca-telemetry init --project <number|url> --json',
    );
  }

  const resolveOpts: ResolveRepositoryOptions = {
    ghPath: options.ghPath,
    gitPath: options.gitPath,
  };

  const resolved = await resolveRepository(options.cwd, remote, resolveOpts);
  const [owner, name] = resolved.github.nameWithOwner.split('/');
  if (!owner || !name) {
    throw usageError(
      'Resolved repository nameWithOwner is invalid.',
      'Check git remotes and gh authentication.',
    );
  }

  const projects = await discoverProjects(
    { owner, name },
    { ghPath: options.ghPath },
  );

  if (projects.length === 0) {
    throw usageError(
      'No GitHub Projects were discovered for this repository.',
      'Create a Project V2 in GitHub and link it to the repo, then run init again.',
    );
  }

  const selected = await resolveProjectSelection(projects, projectFlag, options);

  const paths = resolveAppPaths(createDefaultPathEnv());
  assertAppHomeOutsideGitRoot(resolved.gitRoot, paths.appHome);
  const config = loadConfig(paths.appHome);
  const { config: nextConfig, profile, unchanged } = upsertProfile(
    config,
    resolved.github,
    selected,
    options.now,
  );

  if (!unchanged) {
    saveConfig(paths.appHome, nextConfig);
  }

  const payload = {
    repository: {
      id: resolved.github.id,
      nameWithOwner: resolved.github.nameWithOwner,
      url: resolved.github.url,
      gitRoot: resolved.gitRoot,
      remote: resolved.remoteName,
    },
    profile,
    unchanged,
  };

  if (options.json) {
    return { kind: 'ok', data: payload };
  }

  return {
    kind: 'text',
    write: () => {
      process.stdout.write(
        formatInitTable(
          { nameWithOwner: resolved.github.nameWithOwner },
          {
            project: {
              number: profile.project.number,
              url: profile.project.url,
            },
          },
        ),
      );
    },
  };
}
