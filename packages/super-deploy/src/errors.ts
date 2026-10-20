// Typed errors thrown by the programmatic API. Every error the library throws
// on purpose is a SuperDeployError; `code` is stable and meant for programs,
// `message` is one line meant for people (the CLI prints it after "Error: ").

export type ErrorCode =
  | "project-not-found"
  | "invalid-config"
  | "invalid-draft-name"
  | "draft-name-required"
  | "sql-rule-violation"
  | "desired-schema-load-failed"
  | "unsupported-server"
  | "adapter-failed"
  | "differ-failed";

export class SuperDeployError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** No super-deploy.config.ts in the working directory or any parent. */
export class ProjectNotFoundError extends SuperDeployError {
  readonly searchedFrom: string;

  constructor(searchedFrom: string) {
    super(
      "project-not-found",
      `No super-deploy.config.ts found in ${searchedFrom} or any parent directory`,
    );
    this.searchedFrom = searchedFrom;
  }
}

/** The config file failed to load or a setting is invalid. */
export class ConfigError extends SuperDeployError {
  /** Dotted path of the offending setting, e.g. `targets.dev.lockTimeout`. */
  readonly setting: string | undefined;

  constructor(message: string, setting?: string, options?: ErrorOptions) {
    super("invalid-config", message, options);
    this.setting = setting;
  }
}

export class InvalidDraftNameError extends SuperDeployError {
  readonly input: string;
  /** The input after trimming, lowercasing and collapsing spaces. */
  readonly normalised: string;

  constructor(input: string, normalised: string, reason: string) {
    super(
      "invalid-draft-name",
      `Invalid draft name ${JSON.stringify(input)} (normalised: ${JSON.stringify(normalised)}): ${reason}`,
    );
    this.input = input;
    this.normalised = normalised;
  }
}

export class DraftNameRequiredError extends SuperDeployError {
  constructor() {
    super(
      "draft-name-required",
      "There is no draft yet, so a name is required to create one (--name)",
    );
  }
}

export interface RuleViolation {
  /** Project-relative path with forward slashes. */
  file: string;
  /** 1-based line where the statement (or syntax error) starts. */
  line: number;
  /** The offending statement's text (empty for syntax errors). */
  statement: string;
  /** Stable rule identifier, e.g. `desired-schema-statement`. */
  rule: string;
  message: string;
}

export class SqlRuleViolationError extends SuperDeployError {
  readonly violations: readonly RuleViolation[];

  constructor(violations: readonly RuleViolation[]) {
    const [first] = violations;
    const where = first
      ? `${first.file}:${first.line}: ${first.message} [${first.rule}]`
      : "";
    const more =
      violations.length > 1 ? ` (and ${violations.length - 1} more)` : "";
    super("sql-rule-violation", `${where}${more}`);
    this.violations = violations;
  }
}

/** PostgreSQL refused a desired-schema statement while loading it into a throwaway database. */
export class DesiredSchemaLoadError extends SuperDeployError {
  readonly file: string;
  readonly line: number;
  /** PostgreSQL's own message. */
  readonly detail: string;

  constructor(
    file: string,
    line: number,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(
      "desired-schema-load-failed",
      `${file}:${line}: PostgreSQL refused the desired schema: ${detail}`,
      options,
    );
    this.file = file;
    this.line = line;
    this.detail = detail;
  }
}

/** An adapter connected to a server that isn't PostgreSQL 18. */
export class UnsupportedServerError extends SuperDeployError {
  readonly serverVersion: string;

  constructor(source: string, serverVersion: string) {
    super(
      "unsupported-server",
      `${source} is PostgreSQL ${serverVersion}, but super-deploy requires PostgreSQL 18`,
    );
    this.serverVersion = serverVersion;
  }
}

/** An adapter failed to provide a database or connection. */
export class AdapterError extends SuperDeployError {
  constructor(message: string, options?: ErrorOptions) {
    super("adapter-failed", message, options);
  }
}

export class DifferError extends SuperDeployError {
  constructor(message: string, options?: ErrorOptions) {
    super("differ-failed", message, options);
  }
}
