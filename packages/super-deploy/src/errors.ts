// Typed errors thrown by the programmatic API. Every error the library throws
// on purpose is a SuperDeployError; `code` is stable and meant for programs,
// `message` is one line meant for people (the CLI prints it after "Error: ").
import type { HistoryMismatch, PreflightFindings } from "./deploy/preflight.ts";
import type { DestructiveQuestion, OverwriteQuestion } from "./questions.ts";
import type { DriftedObject } from "./verification/drift.ts";

export type ErrorCode =
  | "project-not-found"
  | "invalid-config"
  | "invalid-draft-name"
  | "draft-name-required"
  | "sql-rule-violation"
  | "desired-schema-load-failed"
  | "order-dependent-desired-schema"
  | "unsupported-server"
  | "adapter-failed"
  | "differ-failed"
  | "interrupted"
  | "invalid-encoding"
  | "no-draft"
  | "sql-file-failed"
  | "rehearsal-mismatch"
  | "migration-integrity"
  | "validation-failed"
  | "unknown-target"
  | "target-locked"
  | "commit-outcome-unknown"
  | "no-migration"
  | "overwrite-not-acknowledged"
  | "destructive-not-acknowledged"
  | "preflight-failed"
  | "terminal-required"
  | "not-confirmed"
  | "target-changed"
  | "init-conflict"
  | "target-drifted"
  | "unknown-recorded-migration"
  | "nothing-to-mark"
  | "history-mismatch"
  | "mark-mismatch";

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

/** `init` would overwrite existing files; nothing was written. */
export class InitConflictError extends SuperDeployError {
  readonly directory: string;
  /** Paths relative to `directory`, sorted. */
  readonly paths: readonly string[];

  constructor(directory: string, paths: readonly string[]) {
    super(
      "init-conflict",
      `Cannot initialise a project in ${directory}: it already has ${paths.join(", ")}`,
    );
    this.directory = directory;
    this.paths = paths;
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
  /** Our explanation of the likely cause, when we know one. */
  readonly hint: string | undefined;

  constructor(
    file: string,
    line: number,
    detail: string,
    options?: ErrorOptions & { hint?: string | undefined },
  ) {
    const hint = options?.hint;
    super(
      "desired-schema-load-failed",
      `${file}:${line}: PostgreSQL refused the desired schema: ${detail}${hint === undefined ? "" : `. Hint: ${hint}`}`,
      options,
    );
    this.file = file;
    this.line = line;
    this.detail = detail;
    this.hint = hint;
  }
}

/**
 * The desired schema gives a different catalog, or fails to load, when its
 * statements load in another valid order (the order-independence check).
 */
export class OrderDependenceError extends SuperDeployError {
  /** The objects whose catalog entries differ, e.g. `view which_pick`, sorted. */
  readonly objects: readonly string[];
  /**
   * The differing catalog facts, as `- <kind>: <line>` when loaded in the
   * normal order and `+ <kind>: <line>` when loaded in the other order.
   */
  readonly differences: readonly string[];
  /** Set when the other order failed to load instead. */
  readonly failure: { file: string; line: number; detail: string } | undefined;

  constructor(
    objects: readonly string[],
    differences: readonly string[],
    failure?: { file: string; line: number; detail: string },
    options?: ErrorOptions,
  ) {
    super(
      "order-dependent-desired-schema",
      failure === undefined
        ? `The desired schema depends on load order: loaded in another valid order, it gives a different catalog for ${listed(objects)}`
        : `The desired schema depends on load order: it loads in one valid order but not in another, where ${failure.file}:${failure.line} fails: ${failure.detail}. super-deploy may not see a reference this statement makes; please report it`,
      options,
    );
    this.objects = objects;
    this.differences = differences;
    this.failure = failure;
  }
}

function listed(objects: readonly string[]): string {
  const shown = objects.slice(0, 5).join(", ");
  return objects.length > 5 ? `${shown} and ${objects.length - 5} more` : shown;
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
 * Replaying the migrations and the draft did not produce the desired schema
 * (or, in a deployment rehearsal, the pending migrations did not produce the
 * newest migration's desired-schema snapshot).
 * Each difference is one line, prefixed with the check that found it:
 * `pg-delta: <statement still needed>` or `catalog: - <line only in the
 * rehearsal>` / `catalog: + <line only in the desired schema>`.
 */
export class RehearsalMismatchError extends SuperDeployError {
  readonly differences: readonly string[];

  /**
   * `subject` replaces the default opening ("The rehearsal does not match
   * the desired schema; run draft again"), e.g. for deployment rehearsals.
   */
  constructor(
    differences: readonly string[],
    options: { subject?: string } = {},
  ) {
    const [first] = differences;
    const more =
      differences.length > 1 ? ` (and ${differences.length - 1} more)` : "";
    super(
      "rehearsal-mismatch",
      `${options.subject ?? "The rehearsal does not match the desired schema; run draft again"}. First difference: ${first ?? ""}${more}`,
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
   * `content-hash-mismatch`, `chain-hash-mismatch`, `sql-rule-violation` (errors);
   * `unfinalized-draft`, `undrafted-changes` (warnings).
   */
  readonly code: string;
  readonly message: string;
  /** Project-relative path with forward slashes, when the problem has one. */
  readonly path?: string;
  /** For `sql-rule-violation`: the 1-based line and the rule id. */
  readonly line?: number;
  readonly rule?: string;
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

/** The command needs a finalized migration and there is none. */
export class NoMigrationError extends SuperDeployError {
  constructor(action: string) {
    super("no-migration", `There is no finalized migration to ${action}`);
  }
}

/**
 * A command would discard work and was not allowed to: nobody could be asked
 * and `acknowledgeOverwrite` wasn't set, or the question was answered no.
 * Nothing was changed.
 */
export class OverwriteNotAcknowledgedError extends SuperDeployError {
  readonly question: OverwriteQuestion;
  /** True when the question was asked and answered no. */
  readonly declined: boolean;

  constructor(question: OverwriteQuestion, declined: boolean) {
    super(
      "overwrite-not-acknowledged",
      declined
        ? `${question.message} Answered no: nothing changed`
        : `${question.message} Refused without a terminal: pass --acknowledge-overwrite to delete or overwrite ${question.paths.join(", ")}`,
    );
    this.question = question;
    this.declined = declined;
  }
}

/**
 * `finalize` found statements that drop structure or delete data, and they
 * were not acknowledged: no `acknowledgeDestructive`, and `confirm` was
 * missing or answered no. Nothing was changed.
 */
export class DestructiveNotAcknowledgedError extends SuperDeployError {
  readonly question: DestructiveQuestion;
  /** True when the question was asked and answered no. */
  readonly declined: boolean;

  constructor(question: DestructiveQuestion, declined: boolean) {
    const statements = question.statements
      .map((s) => `${s.file}:${s.line}: ${s.message}`)
      .join("; ");
    super(
      "destructive-not-acknowledged",
      declined
        ? `${question.message} Answered no: nothing changed`
        : `${question.message} ${statements}. Refused without a terminal: pass --acknowledge-destructive to finalize it anyway`,
    );
    this.question = question;
    this.declined = declined;
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

/** A command named a target that isn't in the config. */
export class UnknownTargetError extends SuperDeployError {
  readonly target: string;
  /** The targets the config does define. */
  readonly known: readonly string[];

  constructor(target: string, known: readonly string[]) {
    super(
      "unknown-target",
      `There is no target ${JSON.stringify(target)} in super-deploy.config.ts (${known.length === 0 ? "no targets are defined" : `targets: ${known.join(", ")}`})`,
    );
    this.target = target;
    this.known = known;
  }
}

/** The holder of a target's lock, as recorded in its history schema. */
export interface LockHolder {
  /** The server process holding the lock. */
  readonly pid: number | undefined;
  /** The running attempt that process recorded, if one is found. */
  readonly attempt:
    | {
        readonly id: number;
        readonly command: string;
        readonly osUser: string;
        readonly startedAt: Date;
      }
    | undefined;
}

/** Another command holds the target's lock (deploy, mark, rebuild, deploy-draft, disposable). */
export class TargetLockedError extends SuperDeployError {
  readonly target: string;
  readonly holder: LockHolder;

  constructor(target: string, holder: LockHolder) {
    const { attempt, pid } = holder;
    const who =
      attempt !== undefined
        ? `attempt #${attempt.id} (${attempt.command} by ${attempt.osUser}, started ${attempt.startedAt.toISOString()})`
        : pid !== undefined
          ? `another session (server process ${pid})`
          : "another session";
    super(
      "target-locked",
      `Target ${target} is locked by ${who}; try again when it has finished`,
    );
    this.target = target;
    this.holder = holder;
  }
}

/**
 * The deploy pre-flight refused the target: a role the deployment grants to
 * or a declared external schema is missing, or its recorded history doesn't
 * match the repo. Nothing was rehearsed or changed; the attempt is logged as
 * failed.
 */
export class PreflightFailedError extends SuperDeployError {
  readonly target: string;
  readonly findings: PreflightFindings;

  constructor(target: string, findings: PreflightFindings) {
    const roles = findings.missingRoles.map(
      (role) =>
        `role "${role}" does not exist (the desired schema grants to it; create it on the target)`,
    );
    const schemas = findings.missingExternalSchemas.map(
      (schema) =>
        `external schema "${schema}" does not exist (it is declared in externalSchemas)`,
    );
    const history = findings.historyMismatches.map(
      (mismatch) => mismatch.message,
    );
    super(
      "preflight-failed",
      `Target ${target} failed the deploy pre-flight checks: ${[...roles, ...schemas, ...history].join("; ")}`,
    );
    this.target = target;
    this.findings = findings;
  }
}

/** The commands that go through the guard (they ask for YES at a terminal). */
export type GuardedCommand = "disposable" | "deploy-draft" | "rebuild" | "mark";

/**
 * A guarded command was run in CI or without a terminal on stdin and stdout.
 * Nothing was read from or written to the target.
 */
export class TerminalRequiredError extends SuperDeployError {
  readonly command: GuardedCommand;
  readonly reason: "ci" | "no-terminal";

  constructor(command: GuardedCommand, reason: "ci" | "no-terminal") {
    super(
      "terminal-required",
      `${command} ${reason === "ci" ? "never runs in CI" : "needs a terminal on stdin and stdout"}: run it yourself at a terminal, where it asks you to type YES`,
    );
    this.command = command;
    this.reason = reason;
  }
}

/** The person at the terminal did not type YES (or cancelled). Nothing changed. */
export class NotConfirmedError extends SuperDeployError {
  readonly command: GuardedCommand;
  readonly target: string;
  /** What was typed instead of YES; undefined when the question was cancelled. */
  readonly typed: string | undefined;

  constructor(
    command: GuardedCommand,
    target: string,
    typed: string | undefined,
  ) {
    super(
      "not-confirmed",
      `${command} on target ${target} was not confirmed (${typed === undefined ? "cancelled" : `typed ${JSON.stringify(typed)}, not YES`}): nothing changed`,
    );
    this.command = command;
    this.target = target;
    this.typed = typed;
  }
}

/**
 * The target's recorded migrations or disposable flag changed between showing
 * them and taking the lock. Nothing changed; run the command again.
 */
export class TargetChangedError extends SuperDeployError {
  readonly command: GuardedCommand;
  readonly target: string;

  constructor(command: GuardedCommand, target: string) {
    super(
      "target-changed",
      `Target ${target} changed while ${command} waited for YES (its recorded migrations or disposable flag): nothing changed; run ${command} again to see the new details`,
    );
    this.command = command;
    this.target = target;
  }
}

/**
 * The connection to a target was lost while its deploy transaction was
 * committing, so whether the deployment landed is unknown. The attempt is
 * recorded as `unknown`; the next `status` or `deploy` settles it as
 * succeeded or failed from the migrations rows the transaction wrote.
 */
export class CommitOutcomeUnknownError extends SuperDeployError {
  readonly target: string;
  readonly attemptId: number;

  constructor(target: string, attemptId: number, options?: ErrorOptions) {
    const cause = options?.cause;
    const reason =
      cause === undefined
        ? ""
        : ` (${cause instanceof Error ? cause.message : String(cause)})`;
    super(
      "commit-outcome-unknown",
      `Lost the connection to target ${target} during COMMIT, so it is unknown whether attempt #${attemptId} landed; the next status or deploy settles it${reason}`,
      options,
    );
    this.target = target;
    this.attemptId = attemptId;
  }
}

/**
 * The target's managed schema differs from what its recorded migrations
 * produce on a replica (column order and ownership aside). Deployments
 * refuse until the target matches again; `status` lists the objects.
 */
export class DriftError extends SuperDeployError {
  readonly target: string;
  /** Sorted by object; never empty. */
  readonly objects: readonly DriftedObject[];

  constructor(target: string, objects: readonly DriftedObject[]) {
    const shown = objects
      .slice(0, 5)
      .map((o) => `${o.object} (${o.change})`)
      .join(", ");
    const more = objects.length > 5 ? ` and ${objects.length - 5} more` : "";
    super(
      "target-drifted",
      `Target ${target} has drifted from its recorded migrations: ${shown}${more}. Deployments refuse until it matches them again (status --target ${target} lists the differences)`,
    );
    this.target = target;
    this.objects = objects;
  }
}

/** The target records migrations the project doesn't have, so no replica of it can be built. */
export class UnknownRecordedMigrationError extends SuperDeployError {
  readonly target: string;
  readonly numbers: readonly number[];

  constructor(target: string, numbers: readonly number[]) {
    super(
      "unknown-recorded-migration",
      `Target ${target} records migration${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}, which the project doesn't have`,
    );
    this.target = target;
    this.numbers = numbers;
  }
}

/** `mark` found no pending migration on the target: there is nothing to record. */
export class NothingToMarkError extends SuperDeployError {
  readonly target: string;

  constructor(target: string) {
    super(
      "nothing-to-mark",
      `Target ${target} has no pending migration to mark: it records every migration in the project`,
    );
    this.target = target;
  }
}

/**
 * What the target records disagrees with the project's migrations (see
 * HistoryMismatch), so no faithful replica of it can be built. Nothing changed.
 */
export class HistoryMismatchError extends SuperDeployError {
  readonly target: string;
  /** Never empty. */
  readonly mismatches: readonly HistoryMismatch[];

  constructor(target: string, mismatches: readonly HistoryMismatch[]) {
    super(
      "history-mismatch",
      `Target ${target}'s recorded migrations don't match the project's: ${mismatches.map((m) => m.message).join("; ")}`,
    );
    this.target = target;
    this.mismatches = mismatches;
  }
}

/**
 * `mark` refused: the target's managed schema differs from a replica of its
 * migrations up to the one being marked (column order and ownership aside).
 * Nothing was recorded.
 */
export class MarkMismatchError extends SuperDeployError {
  readonly target: string;
  /** The migration that was to be marked, e.g. `00002-add-orders`. */
  readonly migration: string;
  /** How the target differs from the replica, sorted by object; never empty. */
  readonly objects: readonly DriftedObject[];

  constructor(
    target: string,
    migration: string,
    objects: readonly DriftedObject[],
  ) {
    const shown = objects
      .slice(0, 5)
      .map((o) => `${o.object} (${o.change})`)
      .join(", ");
    const more = objects.length > 5 ? ` and ${objects.length - 5} more` : "";
    super(
      "mark-mismatch",
      `Target ${target} does not match a replica of its migrations up to ${migration}: ${shown}${more}. Nothing was recorded; fix the target until it matches, then mark again`,
    );
    this.target = target;
    this.migration = migration;
    this.objects = objects;
  }
}
