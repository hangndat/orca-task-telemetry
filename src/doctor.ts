import { existsSync } from 'node:fs';
import { CODEBURN_VERIFIED_VERSION } from './codeburn/adapter.js';
import { ORCA_VERIFIED_VERSION } from './orca/adapter.js';
import { loadConfig } from './config.js';
import { EXIT_ENVIRONMENT, EXIT_SUCCESS, EXIT_USAGE } from './errors.js';
import { checkNodeVersion } from './node-version.js';
import { createDefaultPathEnv, resolveAppPaths } from './paths.js';
import { getProfile } from './profiles.js';
import { readUserVersionReadOnly } from './db/read-only.js';
import { SUPPORTED_SCHEMA_VERSION } from './db/migrate.js';
import { CliError } from './errors.js';
import type { ResolveRepositoryOptions } from './repo.js';
import { resolveRepository } from './repo.js';
import { readGhAuthStatus, type GhAuthStatus } from './github/auth-scopes.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export type DoctorCheck = {
  id: string;
  status: DoctorStatus;
  message: string;
  remedy?: string;
};

export type DoctorReport = {
  summary: DoctorStatus;
  checks: DoctorCheck[];
  exitCode: number;
};

export type DoctorDeps = {
  nodeVersion: string;
  resolveRepo?: (opts?: ResolveRepositoryOptions) => Promise<{
    gitRoot: string;
    github: { id: string };
  }>;
  ghAuthStatus?: () => Promise<GhAuthStatus | { authenticated: boolean; scopes: string[] }>;
  orcaVersion?: () => Promise<string | null>;
  codeburnVersion?: () => Promise<string | null>;
  appHome?: string;
  configExists?: boolean;
  readDbUserVersion?: (dbPath: string) => number | null | Promise<number | null>;
};

function worstStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((c) => c.status === 'fail')) {
    return 'fail';
  }
  if (checks.some((c) => c.status === 'warn')) {
    return 'warn';
  }
  return 'pass';
}

function exitForSummary(summary: DoctorStatus): number {
  if (summary === 'fail') {
    return EXIT_USAGE;
  }
  return EXIT_SUCCESS;
}

export async function runDoctorChecks(
  deps: DoctorDeps,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const node = checkNodeVersion(deps.nodeVersion);
  checks.push(
    node.ok
      ? {
          id: 'node',
          status: 'pass',
          message: `Node.js ${deps.nodeVersion} meets minimum (>= 24).`,
        }
      : {
          id: 'node',
          status: 'fail',
          message: node.message,
          remedy: 'Install Node.js 24 or newer.',
        },
  );

  if (deps.ghAuthStatus) {
    try {
      const auth = await deps.ghAuthStatus();
      if ('known' in auth && !auth.known) {
        checks.push({
          id: 'gh_auth', status: 'warn',
          message: 'Could not verify the active github.com account or its scopes.',
          remedy: 'Run gh auth status --json hosts --no-refresh.',
        });
        checks.push({
          id: 'gh_apply_scope', status: 'warn',
          message: 'Cannot verify the project scope required for --apply.',
          remedy: 'gh auth refresh -s project',
        });
      } else if (!auth.authenticated) {
        checks.push({
          id: 'gh_auth',
          status: 'warn',
          message: 'GitHub CLI is not authenticated.',
          remedy: 'Run gh auth login.',
        });
        checks.push({
          id: 'gh_apply_scope', status: 'warn',
          message: 'Cannot use --apply until github.com authentication is available.',
          remedy: 'gh auth login',
        });
      } else {
        checks.push({
          id: 'gh_auth',
          status: 'pass',
          message: 'GitHub CLI is authenticated.',
        });
        const hasProject =
          auth.scopes.includes('read:project') || auth.scopes.includes('project');
        checks.push(
          hasProject
            ? {
                id: 'gh_scope',
                status: 'pass',
                message: 'Token includes GitHub Projects scope.',
              }
            : {
                id: 'gh_scope',
                status: 'warn',
                message: 'Token is missing read:project scope.',
                remedy: 'gh auth refresh -s read:project',
              },
        );
        checks.push(auth.scopes.includes('project')
          ? { id: 'gh_apply_scope', status: 'pass', message: 'Token includes project scope for --apply.' }
          : {
              id: 'gh_apply_scope', status: 'warn',
              message: 'Token is missing project scope required for --apply.',
              remedy: 'gh auth refresh -s project',
            });
      }
    } catch {
      checks.push({
        id: 'gh_auth',
        status: 'warn',
        message: 'Could not verify GitHub CLI authentication.',
        remedy: 'Install gh and run gh auth login.',
      });
      checks.push({
        id: 'gh_apply_scope', status: 'warn',
        message: 'Cannot verify the project scope required for --apply.',
        remedy: 'gh auth refresh -s project',
      });
    }
  }

  if (deps.orcaVersion) {
    try {
      const version = await deps.orcaVersion();
      if (!version) {
        checks.push({
          id: 'orca',
          status: 'warn',
          message: 'Orca CLI is not available.',
          remedy: 'Install Orca desktop or set ORCA_TELEMETRY_ORCA.',
        });
      } else if (version !== ORCA_VERIFIED_VERSION) {
        checks.push({
          id: 'orca',
          status: 'warn',
          message: `Orca version ${version} is not verified build ${ORCA_VERIFIED_VERSION}.`,
          remedy: 'Upgrade Orca to the verified version in docs/discovery.md.',
        });
      } else {
        checks.push({
          id: 'orca',
          status: 'pass',
          message: `Orca CLI ${version} verified.`,
        });
      }
    } catch {
      checks.push({
        id: 'orca',
        status: 'warn',
        message: 'Orca CLI is not available.',
        remedy: 'Install Orca desktop or set ORCA_TELEMETRY_ORCA.',
      });
    }
  }

  if (deps.codeburnVersion) {
    try {
      const version = await deps.codeburnVersion();
      if (!version) {
        checks.push({
          id: 'codeburn',
          status: 'warn',
          message: 'CodeBurn CLI is not available.',
          remedy: 'Use codeburn@0.9.27 via npx or set ORCA_TELEMETRY_CODEBURN.',
        });
      } else if (version !== CODEBURN_VERIFIED_VERSION) {
        checks.push({
          id: 'codeburn',
          status: 'warn',
          message: `CodeBurn version ${version} is not verified ${CODEBURN_VERIFIED_VERSION}.`,
          remedy: 'Pin codeburn@0.9.27 as documented.',
        });
      } else {
        checks.push({
          id: 'codeburn',
          status: 'pass',
          message: `CodeBurn ${version} verified.`,
        });
      }
    } catch {
      checks.push({
        id: 'codeburn',
        status: 'warn',
        message: 'CodeBurn CLI is not available.',
      });
    }
  }

  const appHome = deps.appHome;
  if (appHome && deps.configExists === false) {
    checks.push({
      id: 'profile',
      status: 'warn',
      message: 'Telemetry config is missing.',
      remedy: 'Run orca-telemetry init in this repository.',
    });
  } else if (deps.resolveRepo && appHome) {
    try {
      const resolved = await deps.resolveRepo();
      const config = loadConfig(appHome);
      getProfile(config, resolved.github.id);
      checks.push({
        id: 'profile',
        status: 'pass',
        message: 'Repository profile is configured.',
      });
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? String(err.code) : '';
      if (code === 'profile_not_found') {
        checks.push({
          id: 'profile',
          status: 'warn',
          message: 'No telemetry profile for this repository.',
          remedy: 'Run orca-telemetry init.',
        });
      } else {
        checks.push({
          id: 'profile',
          status: 'warn',
          message: 'Could not verify repository profile.',
          remedy: 'Run from a git repository with a saved profile.',
        });
      }
    }
  }

  let dbPath: string | null = null;
  if (appHome) {
    const pathEnv = createDefaultPathEnv();
    if (pathEnv.env['ORCA_TELEMETRY_HOME'] === appHome) {
      dbPath = resolveAppPaths({
        ...pathEnv,
        env: { ...pathEnv.env, ORCA_TELEMETRY_HOME: appHome },
      }).dbPath;
    } else {
      dbPath = resolveAppPaths(pathEnv).dbPath;
    }
  }
  if (dbPath) {
    const reader = deps.readDbUserVersion ?? readUserVersionReadOnly;
    try {
      const version = await Promise.resolve(reader(dbPath));
      if (version === null) {
        checks.push({
          id: 'database',
          status: 'warn',
          message: 'Telemetry database does not exist yet.',
          remedy: 'Run orca-telemetry collect after init.',
        });
      } else if (version > SUPPORTED_SCHEMA_VERSION) {
        checks.push({
          id: 'database',
          status: 'fail',
          message: `Database schema v${version} is newer than supported v${SUPPORTED_SCHEMA_VERSION}.`,
          remedy: 'Upgrade orca-task-telemetry to a newer release.',
        });
      } else if (version < SUPPORTED_SCHEMA_VERSION) {
        checks.push({
          id: 'database',
          status: 'warn',
          message: `Database schema v${version} will migrate on next collect.`,
          remedy: 'Run orca-telemetry collect to apply migrations.',
        });
      } else {
        checks.push({
          id: 'database',
          status: 'pass',
          message: `Database schema version ${version} is current.`,
        });
      }
    } catch (err) {
      const message =
        err instanceof CliError ? err.message : 'Could not read telemetry database.';
      const remedy =
        err instanceof CliError && err.hint
          ? err.hint
          : 'Check database permissions and retry.';
      checks.push({
        id: 'database',
        status: 'fail',
        message,
        remedy,
      });
    }
  }

  const summary = worstStatus(checks);
  return { summary, checks, exitCode: exitForSummary(summary) };
}

export function formatDoctorText(report: DoctorReport): string {
  const lines = [`Summary: ${report.summary}`];
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.id}: ${check.message}`);
    if (check.remedy) {
      lines.push(`  remedy: ${check.remedy}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function buildDefaultDoctorDeps(
  cwd: string = process.cwd(),
): Promise<DoctorDeps> {
  const paths = resolveAppPaths(createDefaultPathEnv());
  return {
    nodeVersion: process.version,
    appHome: paths.appHome,
    configExists: existsSync(paths.configPath),
    resolveRepo: async () => {
      const resolved = await resolveRepository(cwd);
      return { gitRoot: resolved.gitRoot, github: resolved.github };
    },
    ghAuthStatus: defaultGhAuthStatus,
    orcaVersion: defaultOrcaVersion,
    codeburnVersion: defaultCodeburnVersion,
    readDbUserVersion: readUserVersionReadOnly,
  };
}

export async function runDoctorCommand(cwd?: string): Promise<number> {
  const report = await runDoctorWithDeps(await buildDefaultDoctorDeps(cwd));
  process.stdout.write(formatDoctorText(report));
  return report.exitCode;
}

async function defaultGhAuthStatus(): Promise<GhAuthStatus> {
  return readGhAuthStatus();
}

async function defaultOrcaVersion(): Promise<string | null> {
  try {
    const { readOrcaVersion } = await import('./orca/adapter.js');
    return await readOrcaVersion();
  } catch {
    return null;
  }
}

async function defaultCodeburnVersion(): Promise<string | null> {
  try {
    const { readCodeburnVersion } = await import('./codeburn/adapter.js');
    return await readCodeburnVersion();
  } catch {
    return null;
  }
}

export async function runDoctorWithDeps(deps: DoctorDeps): Promise<DoctorReport> {
  return runDoctorChecks(deps);
}
