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
export type { PlannedStatement } from "./differ/types.ts";
export {
  AdapterError,
  ConfigError,
  DesiredSchemaLoadError,
  DifferError,
  DraftNameRequiredError,
  type ErrorCode,
  InterruptedError,
  InvalidDraftNameError,
  InvalidEncodingError,
  MigrationIntegrityError,
  NoDraftError,
  ProjectNotFoundError,
  RehearsalMismatchError,
  type RuleViolation,
  SqlFileFailedError,
  SqlRuleViolationError,
  SuperDeployError,
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
export { maxDraftNameLength, normaliseDraftName } from "./store/draft-name.ts";
export type { ProjectPaths } from "./store/layout.ts";
export { toolVersion } from "./version.ts";
