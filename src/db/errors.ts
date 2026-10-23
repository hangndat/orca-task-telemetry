import { CliError, EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE } from '../errors.js';

export function dbError(message: string, hint?: string): CliError {
  return new CliError({
    code: 'db_error',
    message,
    hint,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

export function dbPathError(message: string, hint?: string): CliError {
  return new CliError({
    code: 'db_path_rejected',
    message,
    hint,
    exitCode: EXIT_USAGE,
  });
}

export function dbSchemaError(message: string): CliError {
  return new CliError({
    code: 'db_schema_drift',
    message,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}

export function dbSnapshotConflict(message: string): CliError {
  return new CliError({
    code: 'db_snapshot_conflict',
    message,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}
