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
  | "differ-failed"
  | "interrupted"
  | "invalid-encoding"
  | "no-draft"
  | "sql-file-failed"
  | "rehearsal-mismatch"
  | "migration-integrity"
  | "validation-failed";

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

/** A file that is hashed (finalized migrations, the draft, the desired schema) isn't UTF-8 without a BOM. */
export class InvalidEncodingError extends SuperDeployError {
  /** Project-relative path with forward slashes. */
  readonly file: string;

  constructor(file: string, reason: string, options?: ErrorOptions) {
    super(
      "invalid-encoding",
      `${file} ${reason}; save it as UTF-8 without a byte-order mark`,
      options,
    );
    this.file = file;
  }
}

/** The command needs a draft and there is none. */
export class NoDraftError extends SuperDeployError {
  constructor(action: string) {
    super("no-draft", `There is no draft to ${action}; run draft first`);
  }
}

/** PostgreSQL refused a deploy-time SQL file while a rehearsal replayed it. */
export class SqlFileFailedError extends SuperDeployError {
  /** Project-relative path with forward slashes. */
  readonly file: string;
  /** 1-based line of the error, when PostgreSQL reported a position. */
  readonly line: number | undefined;
  /** PostgreSQL's own message. */
  readonly detail: string;

  constructor(
    file: string,
    line: number | undefined,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(
      "sql-file-failed",
      `${file}${line === undefined ? "" : `:${line}`}: PostgreSQL refused it: ${detail}`,
      options,
    );
    this.file = file;
    this.line = line;
    this.detail = detail;
  }
}

/**
 * Replaying the migrations and the draft did not produce the desired schema.
 * Each difference is one line, prefixed with the check that found it:
 * `pg-delta: <statement still needed>` or `catalog: - <line only in the
 * rehearsal>` / `catalog: + <line only in the desired schema>`.
 */
export class RehearsalMismatchError extends SuperDeployError {
  readonly differences: readonly string[];

  constructor(differences: readonly string[]) {
    const [first] = differences;
    const more =
      differences.length > 1 ? ` (and ${differences.length - 1} more)` : "";
    super(
      "rehearsal-mismatch",
      `The rehearsal does not match the desired schema; run draft again. First difference: ${first ?? ""}${more}`,
    );
    this.differences = differences;
  }
}

export type ValidationSeverity = "error" | "warning";

/** One finding of `validate` (or of the integrity check other commands run first). */
export interface ValidationProblem {
  readonly severity: ValidationSeverity;
  /**
   * Stable identifier: `index-invalid`, `invalid-folder-name`,
   * `unexpected-entry`, `migration-missing`, `migration-unindexed`,
   * `migration-renamed`, `numbering-gap`, `invalid-encoding`,
   * `content-hash-mismatch`, `chain-hash-mismatch` (errors);
   * `unfinalized-draft`, `undrafted-changes` (warnings).
   */
  readonly code: string;
  readonly message: string;
  /** Project-relative path with forward slashes, when the problem has one. */
  readonly path?: string;
}

function summarise(problems: readonly ValidationProblem[]): string {
  const [first] = problems;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
  return `${first?.message ?? ""}${more}`;
}

/** The finalized migrations failed their integrity check, so nothing builds on them. */
export class MigrationIntegrityError extends SuperDeployError {
  readonly problems: readonly ValidationProblem[];

  constructor(problems: readonly ValidationProblem[]) {
    super(
      "migration-integrity",
      `The finalized migrations failed validation: ${summarise(problems)}`,
    );
    this.problems = problems;
  }
}

/** `validate` found errors, or warnings under `--strict`. */
export class ValidationFailedError extends SuperDeployError {
  /** Every finding, errors and warnings, in report order. */
  readonly problems: readonly ValidationProblem[];
  readonly strict: boolean;

  constructor(problems: readonly ValidationProblem[], strict: boolean) {
    const errors = problems.filter((p) => p.severity === "error").length;
    const warnings = problems.length - errors;
    const counts = [
      errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : "",
      warnings > 0
        ? `${warnings} warning${warnings === 1 ? "" : "s"}${strict ? " (--strict)" : ""}`
        : "",
    ]
      .filter((part) => part !== "")
      .join(", ");
    super(
      "validation-failed",
      `Validation failed with ${counts}: ${summarise(problems)}`,
    );
    this.problems = problems;
    this.strict = strict;
  }
}

/**
 * The project's interruption signal aborted while a command was running. The
 * command has cleaned up (rolled back, dropped throwaway databases) by the
 * time this is thrown; `cause` is the signal's abort reason.
 */
export class InterruptedError extends SuperDeployError {
  constructor(options?: ErrorOptions) {
    super("interrupted", "Interrupted", options);
  }
}
