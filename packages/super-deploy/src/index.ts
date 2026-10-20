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
  InvalidDraftNameError,
  OrderDependenceError,
  ProjectNotFoundError,
  type RuleViolation,
  SqlRuleViolationError,
  SuperDeployError,
  UnsupportedServerError,
} from "./errors.ts";
export {
  type LoadProjectOptions,
  loadProject,
  type Project,
} from "./project.ts";
export { maxDraftNameLength, normaliseDraftName } from "./store/draft-name.ts";
export type { ProjectPaths } from "./store/layout.ts";
export { toolVersion } from "./version.ts";
