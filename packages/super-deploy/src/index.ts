// The programmatic API. Every command is an exported function taking a loaded
// project, with flags as options, questions as callbacks, and typed errors.
//
// Guarded commands (`disposable`, `mark`, `deploy-draft`, `rebuild`)
// are the exception: they stay terminal-only. They take no answer callback;
// they ask the person at this process's own terminal to type YES, and throw
// TerminalRequiredError in CI or without a terminal on stdin and stdout.
// No option, flag or environment variable skips that (guard/guard.ts).

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
export { AdapterError } from "./adapters/types.ts";
export {
  AdoptCancelledError,
  AdoptConflictError,
  type AdoptOptions,
  type AdoptResult,
  AdoptUnsupportedError,
  adopt,
  type UnsupportedObject,
} from "./commands/adopt.ts";
export {
  type DeployedMigration,
  type DeployOptions,
  type DeployResult,
  deploy,
} from "./commands/deploy.ts";
export {
  type DeployDraftOptions,
  type DeployDraftResult,
  deployDraft,
  RecoveryBaseMismatchError,
  TargetBehindError,
} from "./commands/deploy-draft.ts";
export {
  type DiscardDraftOptions,
  type DiscardDraftResult,
  discardDraft,
} from "./commands/discard-draft.ts";
export {
  type DisposableOptions,
  type DisposableResult,
  disposable,
} from "./commands/disposable.ts";
export {
  DraftNameRequiredError,
  type DraftOptions,
  type DraftResult,
  draft,
} from "./commands/draft.ts";
export {
  type DestructiveAcknowledgement,
  type FinalizeOptions,
  type FinalizeResult,
  finalize,
  MigrationLimitError,
  type MigrationMetadata,
} from "./commands/finalize.ts";
export {
  InitConflictError,
  type InitOptions,
  type InitResult,
  init,
} from "./commands/init.ts";
export { type MarkOptions, type MarkResult, mark } from "./commands/mark.ts";
export {
  type RebuildOptions,
  type RebuildResult,
  rebuild,
} from "./commands/rebuild.ts";
export {
  DraftExistsError,
  NoRecoveryError,
  RecoveryDraftError,
  type RecoveryOptions,
  type RecoveryResult,
  RecoverySchemaChangeEditedError,
  recovery,
} from "./commands/recovery.ts";
export { type RehearseResult, rehearse } from "./commands/rehearse.ts";
export {
  type RestoredDesiredSchema,
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
  ValidationFailedError,
  type ValidationReport,
  validate,
} from "./commands/validate.ts";
export {
  ConfigError,
  type Duration,
  defineConfig,
  type ResolvedConfig,
  type ResolvedTarget,
  type SuperDeployConfig,
  type TargetConfig,
} from "./config/config.ts";
export { CommitOutcomeUnknownError } from "./deploy/engine.ts";
export type {
  AttemptOutcome,
  AttemptRecord,
  DeployedDraft,
  MigrationVariantIdentity,
  RecordedMigration,
} from "./deploy/history.ts";
export { type LockHolder, TargetLockedError } from "./deploy/lock.ts";
export {
  HistoryMismatchError,
  MarkMismatchError,
  NothingToMarkError,
} from "./deploy/mark.ts";
export type {
  HistoryMismatch,
  PreflightFindings,
} from "./deploy/preflight.ts";
export { PreflightFailedError } from "./deploy/preflight.ts";
export {
  TargetNotDisposableError,
  UnknownTargetError,
} from "./deploy/target.ts";
export { type UnrevokedGrant, WipeFailedError } from "./deploy/wipe.ts";
export type { PlannedStatement } from "./differ/index.ts";
export { DifferError } from "./differ/index.ts";
export { type ErrorCode, SuperDeployError } from "./errors.ts";
export {
  type GuardedCommand,
  NotConfirmedError,
  TargetChangedError,
  TerminalRequiredError,
} from "./guard/guard.ts";
export { InterruptedError } from "./interruption.ts";
export {
  type LoadProjectOptions,
  loadProject,
  type Project,
  ProjectNotFoundError,
} from "./project.ts";
export type {
  AskOverrideReason,
  Confirm,
  DestructiveOptions,
  DestructiveQuestion,
  OverrideNeeded,
  OverrideReasonQuestion,
  OverwriteOptions,
  OverwriteQuestion,
  Question,
} from "./questions.ts";
export {
  DestructiveNotAcknowledgedError,
  OverwriteNotAcknowledgedError,
} from "./questions.ts";
export { OrderDependenceError } from "./rehearsal/order-independence.ts";
export { SqlFileFailedError } from "./rehearsal/replay.ts";
export { UnknownRecordedMigrationError } from "./rehearsal/replica.ts";
export { RehearsalMismatchError } from "./rehearsal/same-structure.ts";
export type {
  ScriptCoverage,
  ScriptCoverageKind,
} from "./rehearsal/script-coverage.ts";
export {
  DesiredSchemaLoadError,
  UnsupportedServerError,
} from "./rehearsal/throwaway.ts";
export type {
  DestructiveKind,
  DestructiveStatement,
  LockWarning,
  LockWarningKind,
} from "./sql-analysis/destructive.ts";
export {
  type RuleViolation,
  SqlRuleViolationError,
} from "./sql-analysis/index.ts";
export type { Override } from "./sql-analysis/overrides.ts";
export { InvalidDraftError, NoDraftError } from "./store/draft.ts";
export {
  InvalidDraftNameError,
  maxDraftNameLength,
  normaliseDraftName,
} from "./store/draft-name.ts";
export { InvalidEncodingError } from "./store/hashing.ts";
export {
  MigrationIntegrityError,
  type ValidationProblem,
  type ValidationSeverity,
} from "./store/integrity.ts";
export type { ProjectPaths } from "./store/layout.ts";
export { NoMigrationError, UnknownMigrationError } from "./store/migrations.ts";
export type { DriftChange, DriftedObject } from "./verification/drift.ts";
export { DriftError } from "./verification/drift.ts";
export { toolVersion } from "./version.ts";
