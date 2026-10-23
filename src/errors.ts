export const EXIT_SUCCESS = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_USAGE = 2;
export const EXIT_ENVIRONMENT = 3;
export const EXIT_SOURCE_UNAVAILABLE = 4;
export const EXIT_PARTIAL = 5;

export type JsonErrorBody = {
  code: string;
  message: string;
  hint?: string;
};

export class CliError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly exitCode: number;

  constructor(options: {
    code: string;
    message: string;
    hint?: string;
    exitCode: number;
  }) {
    super(options.message);
    this.name = 'CliError';
    this.code = options.code;
    this.message = options.message;
    this.hint = options.hint;
    this.exitCode = options.exitCode;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError({
    code: 'usage_error',
    message,
    hint,
    exitCode: EXIT_USAGE,
  });
}

export function unknownCommand(command: string): CliError {
  return new CliError({
    code: 'unknown_command',
    message: `Unknown command: ${command}.`,
    hint: 'Run orca-telemetry --help for usage.',
    exitCode: EXIT_USAGE,
  });
}

export function notImplemented(label: string): CliError {
  return new CliError({
    code: 'not_implemented',
    message: `Command '${label}' is not implemented yet.`,
    hint: 'See docs/MVP-SPEC.md for planned commands.',
    exitCode: EXIT_USAGE,
  });
}

export function nodeVersionError(message: string): CliError {
  return new CliError({
    code: 'environment_error',
    message,
    exitCode: EXIT_ENVIRONMENT,
  });
}
