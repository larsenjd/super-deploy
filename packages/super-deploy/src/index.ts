// The programmatic API. Every command is an exported function taking a loaded
// project, with flags as options, questions as callbacks, and typed errors.

export {
  type ConnectionSource,
  postgresRehearsal,
  postgresTarget,
} from "./adapters/node-postgres.ts";
export type {
  CollationProvider,
  DatabaseRequest,
  DeploymentAdapter,
  QueryResult,
  RehearsalAdapter,
  Session,
  ThrowawayDatabase,
} from "./adapters/types.ts";
export {
  type DeployedMigration,
  type DeployOptions,
  type DeployResult,
  deploy,
} from "./commands/deploy.ts";
export {
  type DiscardDraftOptions,
  type DiscardDraftResult,
  discardDraft,
} from "./commands/discard-draft.ts";
export {
  type DraftOptions,
  type DraftResult,
  draft,
} from "./commands/draft.ts";
export {
  type FinalizeResult,
  finalize,
  type MigrationMetadata,
} from "./commands/finalize.ts";
export { type RehearseResult, rehearse } from "./commands/rehearse.ts";
export {
  type RestoreSchemaOptions,
  type RestoreSchemaResult,
  restoreSchema,
} from "./commands/restore-schema.ts";
export {
  type StatusOptions,
  type StatusReport,
  status,
} from "./commands/status.ts";
export {
  type UnfinalizeOptions,
  type UnfinalizeResult,
  unfinalize,
} from "./commands/unfinalize.ts";
export {
  type ValidateOptions,
  type ValidationReport,
  validate,
} from "./commands/validate.ts";
export {
  type Duration,
  defineConfig,
  type ResolvedConfig,
  type ResolvedTarget,
  type SuperDeployConfig,
  type TargetConfig,
} from "./config/config.ts";
export type {
  AttemptOutcome,
  AttemptRecord,
  RecordedMigration,
} from "./deploy/history.ts";
export type { PlannedStatement } from "./differ/types.ts";
export {
  AdapterError,
  ConfigError,
  DesiredSchemaLoadError,
  DifferError,
  DraftNameRequiredError,
  DriftError,
  type ErrorCode,
  InterruptedError,
  InvalidDraftNameError,
  InvalidEncodingError,
  type LockHolder,
  MigrationIntegrityError,
  NoDraftError,
  NoMigrationError,
  OrderDependenceError,
  OverwriteNotAcknowledgedError,
  ProjectNotFoundError,
  RehearsalMismatchError,
  type RuleViolation,
  SqlFileFailedError,
  SqlRuleViolationError,
  SuperDeployError,
  TargetLockedError,
  UnknownRecordedMigrationError,
  UnknownTargetError,
  UnsupportedServerError,
  ValidationFailedError,
  type ValidationProblem,
  type ValidationSeverity,
} from "./errors.ts";
export {
  type LoadProjectOptions,
  loadProject,
  type Project,
} from "./project.ts";
export type {
  Confirm,
  OverwriteOptions,
  OverwriteQuestion,
  Question,
} from "./questions.ts";
export { maxDraftNameLength, normaliseDraftName } from "./store/draft-name.ts";
export type { ProjectPaths } from "./store/layout.ts";
export type { DriftChange, DriftedObject } from "./verification/drift.ts";
export { toolVersion } from "./version.ts";
