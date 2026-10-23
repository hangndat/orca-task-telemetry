import type { JsonErrorBody } from '../errors.js';
import { CliError } from '../errors.js';

export function writeJsonSuccess(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

export function writeJsonError(error: JsonErrorBody): void {
  process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
}

export function writeTextError(error: CliError): void {
  process.stderr.write(`error: ${error.message}\n`);
  if (error.hint) {
    process.stderr.write(`hint: ${error.hint}\n`);
  }
}

export function emitCliError(error: CliError, json: boolean): void {
  if (json) {
    writeJsonError({
      code: error.code,
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
    });
  } else {
    writeTextError(error);
  }
}

export function emitUnexpectedError(err: unknown, json: boolean): number {
  const debug = process.env.ORCA_TELEMETRY_DEBUG === '1';
  if (debug && err instanceof Error) {
    process.stderr.write(`${err.stack ?? err.message}\n`);
  }
  if (json) {
    writeJsonError({
      code: 'internal_error',
      message: 'An unexpected error occurred.',
    });
  } else {
    process.stderr.write('error: An unexpected error occurred.\n');
  }
  return 1;
}
