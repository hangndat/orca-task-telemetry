import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { CliError, EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE } from './errors.js';
import { CONFIG_FILE_NAME } from './paths.js';

export const CONFIG_VERSION = 1;

/** Version-1 config envelope; profile bodies are defined in T11. */
export type ConfigEnvelopeV1 = {
  version: typeof CONFIG_VERSION;
  profiles: Record<string, Record<string, never>>;
};

export function emptyConfig(): ConfigEnvelopeV1 {
  return { version: CONFIG_VERSION, profiles: {} };
}

function configError(
  code: string,
  message: string,
  hint?: string,
  exitCode = EXIT_USAGE,
): CliError {
  return new CliError({ code, message, hint, exitCode });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProfiles(value: unknown): Record<string, Record<string, never>> {
  if (!isPlainObject(value)) {
    throw configError(
      'config_invalid_shape',
      'Config profiles must be an object.',
    );
  }
  const out: Record<string, Record<string, never>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      throw configError(
        'config_invalid_shape',
        `Profile '${key}' must be an object.`,
      );
    }
    out[key] = entry as Record<string, never>;
  }
  return out;
}

/**
 * Parse and validate config JSON text (no I/O).
 */
export function parseConfigJson(text: string): ConfigEnvelopeV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw configError('config_parse_error', 'Config file is not valid JSON.');
  }

  if (!isPlainObject(parsed)) {
    throw configError(
      'config_invalid_shape',
      'Config root must be a JSON object.',
    );
  }

  const version = parsed['version'];
  if (version === undefined) {
    throw configError(
      'config_invalid_shape',
      'Config is missing version field.',
    );
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw configError(
      'config_invalid_shape',
      'Config version must be an integer.',
    );
  }
  if (version > CONFIG_VERSION) {
    throw configError(
      'config_unsupported_version',
      `Config version ${version} is newer than supported version ${CONFIG_VERSION}.`,
      'Upgrade orca-task-telemetry before modifying this config.',
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
  if (version < CONFIG_VERSION) {
    throw configError(
      'config_unsupported_version',
      `Config version ${version} is not supported.`,
    );
  }

  const profilesValue = parsed['profiles'];
  const profilesInput =
    profilesValue === undefined ? {} : profilesValue;

  return {
    version: CONFIG_VERSION,
    profiles: parseProfiles(profilesInput),
  };
}

function configPathForAppHome(appHome: string): string {
  return path.join(appHome, CONFIG_FILE_NAME);
}

/**
 * Load config from `appHome/config.json`. Missing file returns empty in-memory v1 config.
 */
export function loadConfig(appHome: string): ConfigEnvelopeV1 {
  const configPath = configPathForAppHome(appHome);
  if (!existsSync(configPath)) {
    return emptyConfig();
  }
  const text = readFileSync(configPath, 'utf8');
  return parseConfigJson(text);
}

function assertSafeTempParent(appHome: string): void {
  const stat = lstatSync(appHome);
  if (stat.isSymbolicLink()) {
    throw configError(
      'config_write_error',
      'App home directory must not be a symlink for atomic config writes.',
      undefined,
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
}

export type ConfigIo = {
  mkdirSync: typeof mkdirSync;
  chmodSync: typeof chmodSync;
  existsSync: typeof existsSync;
  lstatSync: typeof lstatSync;
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  randomTempSuffix: () => string;
};

export function createDefaultConfigIo(): ConfigIo {
  return {
    mkdirSync,
    chmodSync,
    existsSync,
    lstatSync,
    openSync,
    writeSync,
    closeSync,
    renameSync,
    unlinkSync,
    randomTempSuffix: () => randomBytes(8).toString('hex'),
  };
}

function ensureAppHomeDir(appHome: string, io: ConfigIo): void {
  io.mkdirSync(appHome, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    io.chmodSync(appHome, 0o700);
  }
}

/**
 * Atomically write config to `appHome/config.json`.
 */
export function saveConfig(
  appHome: string,
  config: ConfigEnvelopeV1,
  io: ConfigIo = createDefaultConfigIo(),
): void {
  if (config.version !== CONFIG_VERSION) {
    throw configError(
      'config_unsupported_version',
      `Only config version ${CONFIG_VERSION} can be saved.`,
    );
  }

  ensureAppHomeDir(appHome, io);
  assertSafeTempParent(appHome);

  const configPath = configPathForAppHome(appHome);
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const tempName = `.${CONFIG_FILE_NAME}.${io.randomTempSuffix()}.tmp`;
  const tempPath = path.join(appHome, tempName);

  if (io.existsSync(tempPath)) {
    const tempStat = io.lstatSync(tempPath);
    if (tempStat.isSymbolicLink()) {
      throw configError(
        'config_write_error',
        'Refusing to write through an existing temp symlink.',
        undefined,
        EXIT_SOURCE_UNAVAILABLE,
      );
    }
  }

  let fd: number | undefined;
  try {
    fd = io.openSync(tempPath, 'w', 0o600);
    io.writeSync(fd, payload, undefined, 'utf8');
    io.closeSync(fd);
    fd = undefined;
    if (process.platform !== 'win32') {
      io.chmodSync(tempPath, 0o600);
    }
    io.renameSync(tempPath, configPath);
    if (process.platform !== 'win32') {
      io.chmodSync(configPath, 0o600);
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      if (io.existsSync(tempPath)) {
        io.unlinkSync(tempPath);
      }
    } catch {
      // ignore cleanup errors
    }
    const message =
      err instanceof Error ? err.message : 'Unknown error writing config.';
    throw configError(
      'config_write_error',
      `Failed to write config atomically: ${message}`,
      undefined,
      EXIT_SOURCE_UNAVAILABLE,
    );
  }
}
