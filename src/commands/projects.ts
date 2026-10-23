import { parseArgs } from 'node:util';
import { discoverProjects } from '../github/projects.js';
import { usageError } from '../errors.js';
import { resolveRepository, type ResolveRepositoryOptions } from '../repo.js';
import type { RouteResult } from './router.js';

export type ProjectsCommandOptions = {
  json: boolean;
  cwd: string;
  ghPath?: string;
  gitPath?: string;
};

function parseProjectsArgs(rest: string[]): { remote?: string } {
  try {
    const parsed = parseArgs({
      args: rest,
      options: {
        remote: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length > 0) {
      throw usageError(
        'projects command does not take positional arguments.',
        'Usage: orca-telemetry projects [--remote <name>] [--json]',
      );
    }
    const remote = parsed.values.remote;
    if (remote !== undefined && remote.length === 0) {
      throw usageError('--remote requires a value.', 'Example: --remote origin');
    }
    return { remote };
  } catch (err) {
    if (err instanceof Error && err.name === 'TypeError') {
      throw usageError(err.message, 'Usage: orca-telemetry projects [--remote <name>]');
    }
    throw err;
  }
}

function formatProjectsTable(
  repository: { nameWithOwner: string; url: string },
  projects: Awaited<ReturnType<typeof discoverProjects>>,
): string {
  const lines = [
    `Repository: ${repository.nameWithOwner}`,
    `Projects: ${projects.length}`,
    '',
    'NUMBER  CLOSED  OWNER           TITLE',
  ];
  for (const project of projects) {
    const owner = `${project.owner.kind}:${project.owner.login}`;
    const closed = project.closed ? 'yes' : 'no';
    const title =
      project.title.length > 48
        ? `${project.title.slice(0, 47)}…`
        : project.title;
    lines.push(
      `${String(project.number).padEnd(6)}${closed.padEnd(8)}${owner.padEnd(16)}${title}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function runProjects(
  rest: string[],
  options: ProjectsCommandOptions,
): Promise<RouteResult> {
  const { remote } = parseProjectsArgs(rest);
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

  const payload = {
    repository: {
      id: resolved.github.id,
      nameWithOwner: resolved.github.nameWithOwner,
      url: resolved.github.url,
      gitRoot: resolved.gitRoot,
      remote: resolved.remoteName,
    },
    projects,
  };

  if (options.json) {
    return { kind: 'ok', data: payload };
  }

  return {
    kind: 'text',
    write: () => {
      process.stdout.write(
        formatProjectsTable(
          { nameWithOwner: resolved.github.nameWithOwner, url: resolved.github.url },
          projects,
        ),
      );
    },
  };
}
