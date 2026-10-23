import { CliError, EXIT_SOURCE_UNAVAILABLE, EXIT_USAGE } from '../errors.js';

export function attributionSessionUnknown(sessionKey: string): CliError {
  return new CliError({
    code: 'attribution_session_unknown',
    message: `Usage session ${sessionKey} is not in the database.`,
    hint: 'Collect CodeBurn sessions before linking.',
    exitCode: EXIT_USAGE,
  });
}

export function attributionIssueUnknown(issueNodeId: string): CliError {
  return new CliError({
    code: 'attribution_issue_unknown',
    message: `Issue ${issueNodeId} is not in the database.`,
    hint: 'Import GitHub project issues before linking.',
    exitCode: EXIT_USAGE,
  });
}

export function attributionLinkConflict(
  sessionKey: string,
  existingIssueNodeId: string,
): CliError {
  return new CliError({
    code: 'attribution_link_conflict',
    message: `Session ${sessionKey} is already linked to issue ${existingIssueNodeId}.`,
    hint: 'Unlink is not supported in MVP; choose another session or issue.',
    exitCode: EXIT_USAGE,
  });
}

export function attributionIntegrityError(message: string): CliError {
  return new CliError({
    code: 'attribution_integrity_failed',
    message,
    exitCode: EXIT_SOURCE_UNAVAILABLE,
  });
}
