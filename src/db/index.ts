export {
  openTelemetryDatabase,
  type OpenDatabaseOptions,
  type TelemetryDatabase,
} from './connection.js';
export {
  openReadOnlyTelemetryDb,
  preflightReadOnlySource,
  readUserVersionReadOnly,
  type ReadOnlyTelemetryHandle,
} from './read-only.js';
export {
  migrateDatabase,
  assertSchemaCurrent,
  SUPPORTED_SCHEMA_VERSION,
} from './migrate.js';
export { SCHEMA_VERSION_V1 } from './migrations/v1.js';
export {
  importGitHubRecords,
  importOrcaExecutions,
  importUsageSnapshots,
  insertSessionLink,
  countRows,
  sanitizeCollectionMessage,
  type GitHubImportInput,
  type UsageImportRow,
  type CollectionSource,
} from './repository.js';

export {
  scopedExecutionKey,
  insertScopedExecution,
  insertManualRoleLink,
  insertRoleLinkAudit,
  insertCollectionAttempt,
  finishAgentTopCollectionAttempt,
  verifierIdentityHash,
  VERIFIER_PATTERN,
  type ManualEvidenceNote,
} from './run-provenance.js';
