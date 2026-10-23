import os from 'node:os';
import path from 'node:path';
import pathWin32 from 'node:path/win32';
import { CliError, EXIT_ENVIRONMENT, EXIT_USAGE } from './errors.js';

export const APP_DIR_NAME = 'orca-task-telemetry';
export const CONFIG_FILE_NAME = 'config.json';
export const DB_FILE_NAME = 'telemetry.sqlite';

export type PathPlatform = 'darwin' | 'linux' | 'win32';

export type PathEnv = {
  platform: PathPlatform;
  env: Record<string, string | undefined>;
  homedir: () => string;
};

export type ResolvedAppPaths = {
  appHome: string;
  configPath: string;
  dbPath: string;
};

function pathApi(platform: PathPlatform) {
  return platform === 'win32' ? pathWin32 : path;
}

function pathsError(message: string, hint?: string): CliError {
  return new CliError({
    code: 'paths_error',
    message,
    hint,
    exitCode: EXIT_USAGE,
  });
}

function requireAbsolutePath(
  value: string,
  label: string,
  platform: PathPlatform,
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw pathsError(`${label} must not be empty.`);
  }
  const api = pathApi(platform);
  if (!api.isAbsolute(trimmed)) {
    throw pathsError(
      `${label} must be an absolute path.`,
      'Set ORCA_TELEMETRY_HOME to a full absolute directory path.',
    );
  }
  return trimmed;
}

function resolveFromTelemetryHome(env: PathEnv): string | null {
  if (!Object.hasOwn(env.env, 'ORCA_TELEMETRY_HOME')) {
    return null;
  }
  const raw = env.env['ORCA_TELEMETRY_HOME'];
  if (raw === undefined || raw.length === 0 || raw.trim().length === 0) {
    throw pathsError(
      'ORCA_TELEMETRY_HOME must not be empty.',
      'Unset the variable to use the default app data directory, or set an absolute path.',
    );
  }
  return requireAbsolutePath(raw, 'ORCA_TELEMETRY_HOME', env.platform);
}

function resolveDefaultAppHome(env: PathEnv): string {
  const api = pathApi(env.platform);
  const home = env.homedir();
  if (home.length === 0) {
    throw new CliError({
      code: 'paths_error',
      message: 'Could not determine user home directory.',
      exitCode: EXIT_ENVIRONMENT,
    });
  }

  switch (env.platform) {
    case 'darwin':
      return api.join(home, 'Library', 'Application Support', APP_DIR_NAME);
    case 'linux': {
      const xdg = env.env['XDG_DATA_HOME'];
      if (xdg !== undefined && xdg.length > 0) {
        const abs = requireAbsolutePath(xdg, 'XDG_DATA_HOME', env.platform);
        return api.join(abs, APP_DIR_NAME);
      }
      return api.join(home, '.local', 'share', APP_DIR_NAME);
    }
    case 'win32': {
      const local = env.env['LOCALAPPDATA'];
      if (local !== undefined && local.length > 0) {
        const abs = requireAbsolutePath(local, 'LOCALAPPDATA', env.platform);
        return api.join(abs, APP_DIR_NAME);
      }
      return api.join(home, 'AppData', 'Local', APP_DIR_NAME);
    }
    default:
      throw pathsError(`Unsupported platform: ${env.platform as string}`);
  }
}

/**
 * Resolve application data directory and standard file paths (no I/O).
 */
export function resolveAppPaths(env: PathEnv): ResolvedAppPaths {
  const api = pathApi(env.platform);
  const override = resolveFromTelemetryHome(env);
  const appHome = override ?? resolveDefaultAppHome(env);
  return {
    appHome,
    configPath: api.join(appHome, CONFIG_FILE_NAME),
    dbPath: api.join(appHome, DB_FILE_NAME),
  };
}

/** Production defaults from the current process. */
export function createDefaultPathEnv(): PathEnv {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw pathsError(`Unsupported platform: ${platform}`);
  }
  return {
    platform,
    env: process.env,
    homedir: os.homedir,
  };
}

export function resolveDefaultAppPaths(): ResolvedAppPaths {
  return resolveAppPaths(createDefaultPathEnv());
}
