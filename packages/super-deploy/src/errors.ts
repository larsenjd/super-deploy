// Typed errors thrown by the programmatic API. Every error the library throws
// on purpose is a SuperDeployError subclass that declares its own `code`;
// the code is stable and meant for programs,
// `message` is one line meant for people (the CLI prints it after "Error: ").
import type { HistoryMismatch, PreflightFindings } from "./deploy/preflight.ts";
import type {
  DestructiveQuestion,
  OverrideNeeded,
  OverwriteQuestion,
} from "./questions.ts";
import type { DriftedObject } from "./verification/drift.ts";

/**
 * Every stable `code`: computed from the error classes the package exports,
 * so a new error adds its code by declaring it on its class. An error whose
 * class isn't exported from index.ts fails to compile here.
 */
export type ErrorCode = {
  [Name in Exported]: Api[Name] extends abstract new (
    ...args: never[]
  ) => { readonly code: infer Code extends string }
    ? Code
    : never;
}[Exported];

type Api = typeof import("./index.ts");
// The base class is left out by name: its code is this type.
type Exported = Exclude<keyof Api, "SuperDeployError">;

export abstract class SuperDeployError extends Error {
  abstract readonly code: ErrorCode;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No super-deploy.config.ts in the working directory or any parent. */
export class ProjectNotFoundError extends SuperDeployError {
  readonly code = "project-not-found";
  readonly searchedFrom: string;

  constructor(searchedFrom: string) {
    super(
      `No super-deploy.config.ts found in ${searchedFrom} or any parent directory`,
    );
    this.searchedFrom = searchedFrom;
  }
}

/** `init` would overwrite existing files; nothing was written. */
export class InitConflictError extends SuperDeployError {
  readonly code = "init-conflict";
  readonly directory: string;
  /** Paths relative to `directory`, sorted. */
  readonly paths: readonly string[];

  constructor(directory: string, paths: readonly string[]) {
    super(
      `Cannot initialise a project in ${directory}: it already has ${paths.join(", ")}`,
    );
    this.directory = directory;
    this.paths = paths;
  }
}

/** The config file failed to load or a setting is invalid. */
export class ConfigError extends SuperDeployError {
  readonly code = "invalid-config";
  /** Dotted path of the offending setting, e.g. `targets.dev.lockTimeout`. */
  readonly setting: string | undefined;

  constructor(message: string, setting?: string, options?: ErrorOptions) {
    super(message, options);
    this.setting = setting;
  }
}

export class InvalidDraftNameError extends SuperDeployError {
  readonly code = "invalid-draft-name";
  readonly input: string;
  /** The input after trimming, lowercasing and collapsing spaces. */
  readonly normalised: string;

  constructor(input: string, normalised: string, reason: string) {
    super(
      `Invalid draft name ${JSON.stringify(input)} (normalised: ${JSON.stringify(normalised)}): ${reason}`,
    );
    this.input = input;
    this.normalised = normalised;
  }
}

export class DraftNameRequiredError extends SuperDeployError {
  readonly code = "draft-name-required";

  constructor() {
    super(
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
  readonly code = "sql-rule-violation";
  readonly violations: readonly RuleViolation[];

  constructor(violations: readonly RuleViolation[]) {
    const [first] = violations;
    const where = first
      ? `${first.file}:${first.line}: ${first.message} [${first.rule}]`
      : "";
    const more =
      violations.length > 1 ? ` (and ${violations.length - 1} more)` : "";
    super(`${where}${more}`);
    this.violations = violations;
  }
}

/** PostgreSQL refused a desired-schema statement while loading it into a throwaway database. */
export class DesiredSchemaLoadError extends SuperDeployError {
  readonly code = "desired-schema-load-failed";
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
  readonly code = "order-dependent-desired-schema";
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

/** Up to five drifted objects with their change, e.g. `table t (changed)`. */
function listedDrift(objects: readonly DriftedObject[]): string {
  return listed(objects.map((o) => `${o.object} (${o.change})`));
}

/** An adapter connected to a server that isn't PostgreSQL 18. */
export class UnsupportedServerError extends SuperDeployError {
  readonly code = "unsupported-server";
  readonly serverVersion: string;

  constructor(source: string, serverVersion: string) {
    super(
      `${source} is PostgreSQL ${serverVersion}, but super-deploy requires PostgreSQL 18`,
    );
    this.serverVersion = serverVersion;
  }
}

/** An adapter failed to provide a database or connection. */
export class AdapterError extends SuperDeployError {
  readonly code = "adapter-failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class DifferError extends SuperDeployError {
  readonly code = "differ-failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** A file that is hashed (finalized migrations, the draft, the desired schema) isn't UTF-8 without a BOM. */
export class InvalidEncodingError extends SuperDeployError {
  readonly code = "invalid-encoding";
  /** Project-relative path with forward slashes. */
  readonly file: string;

  constructor(file: string, reason: string, options?: ErrorOptions) {
    super(
      `${file} ${reason}; save it as UTF-8 without a byte-order mark`,
      options,
    );
    this.file = file;
  }
}

/** The command needs a draft and there is none. */
export class NoDraftError extends SuperDeployError {
  readonly code = "no-draft";

  constructor(action: string) {
    super(`There is no draft to ${action}; run draft first`);
  }
}

/** draft.json can't be read as a draft's metadata. */
export class InvalidDraftError extends SuperDeployError {
  readonly code = "invalid-draft";
  /** Project-relative path of draft.json. */
  readonly file: string;

  constructor(file: string, problem: string, options?: ErrorOptions) {
    super(`${file} ${problem}`, options);
    this.file = file;
  }
}

/** PostgreSQL refused a deploy-time SQL file while a rehearsal replayed it. */
export class SqlFileFailedError extends SuperDeployError {
  readonly code = "sql-file-failed";
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
  readonly code = "rehearsal-mismatch";
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
   * `content-hash-mismatch`, `chain-hash-mismatch`, `sql-rule-violation`,
   * `recovery-schema-change-edited`, `unknown-migration` (errors);
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
  readonly code = "migration-integrity";
  readonly problems: readonly ValidationProblem[];

  constructor(problems: readonly ValidationProblem[]) {
    super(`The finalized migrations failed validation: ${summarise(problems)}`);
    this.problems = problems;
  }
}

/** Finalizing would number a migration past the last number folders allow. */
export class MigrationLimitError extends SuperDeployError {
  readonly code = "migration-limit";
  readonly limit: number;

  constructor(limit: number) {
    super(`Migration numbers stop at ${limit}`);
    this.limit = limit;
  }
}

/** `validate` found errors, or warnings under `--strict`. */
export class ValidationFailedError extends SuperDeployError {
  readonly code = "validation-failed";
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
    super(`Validation failed with ${counts}: ${summarise(problems)}`);
    this.problems = problems;
    this.strict = strict;
  }
}

/** One draft at a time: the command would create one while another exists. Nothing was changed. */
export class DraftExistsError extends SuperDeployError {
  readonly code = "draft-exists";
  /** The existing draft's name, if its draft.json is readable. */
  readonly draft: string | undefined;

  constructor(action: string, draft: string | undefined) {
    super(
      `Cannot ${action} while draft ${draft ?? "(unnamed)"} exists: finalize it or run discard-draft first`,
    );
    this.draft = draft;
  }
}

/**
 * The draft is a Recovery draft, whose schema change is its migration's and
 * is never regenerated, and the command would regenerate it.
 */
export class RecoveryDraftError extends SuperDeployError {
  readonly code = "recovery-draft";
  /** The migration the Recovery draft recovers. */
  readonly migration: number;

  constructor(migration: number) {
    super(
      `The draft is a Recovery of migration ${migration}: its schema change is migration ${migration}'s and is never regenerated. Edit its scripts and seed data, then rehearse or finalize it (or discard-draft)`,
    );
    this.migration = migration;
  }
}

/** A Recovery draft's schema-change.sql is no longer a copy of its migration's. */
export class RecoverySchemaChangeEditedError extends SuperDeployError {
  readonly code = "recovery-schema-change-edited";
  /** Project-relative path of the draft's schema change. */
  readonly file: string;

  constructor(file: string, migration: string) {
    super(
      `${file} must stay an exact copy of ${migration}'s schema change: a Recovery replaces only the scripts and seed data`,
    );
    this.file = file;
  }
}

/** `unfinalize` was asked for a migration's newest Recovery and it has none. */
export class NoRecoveryError extends SuperDeployError {
  readonly code = "no-recovery";

  constructor(migration: string) {
    super(`Migration ${migration} has no Recovery to unfinalize`);
  }
}

/** The command needs a finalized migration and there is none. */
export class NoMigrationError extends SuperDeployError {
  readonly code = "no-migration";

  constructor(action: string) {
    super(`There is no finalized migration to ${action}`);
  }
}

/**
 * A command would discard work and was not allowed to: nobody could be asked
 * and `acknowledgeOverwrite` wasn't set, or the question was answered no.
 * Nothing was changed.
 */
export class OverwriteNotAcknowledgedError extends SuperDeployError {
  readonly code = "overwrite-not-acknowledged";
  readonly question: OverwriteQuestion;
  /** True when the question was asked and answered no. */
  readonly declined: boolean;

  constructor(question: OverwriteQuestion, declined: boolean) {
    super(
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
  readonly code = "destructive-not-acknowledged";
  readonly question: DestructiveQuestion;
  /** True when the question was asked and answered no. */
  readonly declined: boolean;

  constructor(question: DestructiveQuestion, declined: boolean) {
    const statements = question.statements
      .map((s) => `${s.file}:${s.line}: ${s.message}`)
      .join("; ");
    super(
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
  readonly code = "interrupted";

  constructor(options?: ErrorOptions) {
    super("Interrupted", options);
  }
}

/** A command named a target that isn't in the config. */
export class UnknownTargetError extends SuperDeployError {
  readonly code = "unknown-target";
  readonly target: string;
  /** The targets the config does define. */
  readonly known: readonly string[];

  constructor(target: string, known: readonly string[]) {
    super(
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
  readonly code = "target-locked";
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
  readonly code = "preflight-failed";
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
  readonly code = "terminal-required";
  readonly command: GuardedCommand;
  readonly reason: "ci" | "no-terminal";

  constructor(command: GuardedCommand, reason: "ci" | "no-terminal") {
    super(
      `${command} ${reason === "ci" ? "never runs in CI" : "needs a terminal on stdin and stdout"}: run it yourself at a terminal, where it asks you to type YES`,
    );
    this.command = command;
    this.reason = reason;
  }
}

/** The person at the terminal did not type YES (or cancelled). Nothing changed. */
export class NotConfirmedError extends SuperDeployError {
  readonly code = "not-confirmed";
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
      `${command} on target ${target} was not confirmed (${typed === undefined ? "cancelled" : `typed ${JSON.stringify(typed)}, not YES`}): nothing changed`,
    );
    this.command = command;
    this.target = target;
    this.typed = typed;
  }
}

/**
 * deploy-draft or rebuild was refused because the target's own history
 * schema doesn't flag it as disposable (`disposable --set yes`). Nothing was
 * asked or changed.
 */
export class TargetNotDisposableError extends SuperDeployError {
  readonly code = "target-not-disposable";
  readonly command: GuardedCommand;
  readonly target: string;

  constructor(command: GuardedCommand, target: string) {
    super(
      `${command} only runs on disposable targets, and target ${target} is not disposable (flag it with disposable --target ${target} --set yes if it is safe to wipe): nothing changed`,
    );
    this.command = command;
    this.target = target;
  }
}

/**
 * deploy-draft was refused because the target has pending migrations: the
 * draft's schema change was generated on top of the newest migration, so
 * the target must be there first. Nothing was asked or changed.
 */
export class TargetBehindError extends SuperDeployError {
  readonly code = "target-behind";
  readonly target: string;
  /** The pending migrations' folder names, in order. */
  readonly pending: readonly string[];

  constructor(target: string, pending: readonly string[]) {
    super(
      `Target ${target} has pending migrations (${pending.join(", ")}): deploy them first, because the draft goes on top of the newest migration`,
    );
    this.target = target;
    this.pending = pending;
  }
}

/**
 * deploy-draft of a Recovery draft of migration N needs a target whose last
 * recorded migration is N-1: the Recovery runs N's schema change.
 */
export class RecoveryBaseMismatchError extends SuperDeployError {
  readonly code = "recovery-base-mismatch";
  readonly target: string;
  /** The recovered migration's folder name. */
  readonly migration: string;
  /** The folder of migration N-1; undefined when N is 1. */
  readonly base: string | undefined;
  /** The target's last recorded migration's folder; undefined when none is recorded. */
  readonly recorded: string | undefined;

  constructor(
    target: string,
    migration: string,
    base: string | undefined,
    recorded: string | undefined,
    baseNumber: number,
  ) {
    const fix =
      baseNumber === 0
        ? "use a target with no recorded migrations"
        : `run rebuild --to ${baseNumber} first`;
    super(
      `The Recovery draft of migration ${migration} runs on top of ${base ?? "no recorded migration"}, but target ${target} is at ${recorded ?? "no recorded migration"}: ${fix}`,
    );
    this.target = target;
    this.migration = migration;
    this.base = base;
    this.recorded = recorded;
  }
}

/** A grant on the managed schema that rebuild's deploy role couldn't revoke. */
export interface UnrevokedGrant {
  /** E.g. `USAGE`. */
  readonly privilege: string;
  /** The role it is granted to (quoted if need be), or `PUBLIC`. */
  readonly grantee: string;
  /** The role that granted it (quoted if need be). */
  readonly grantor: string;
  /** Whether the grantor is the schema's owner. */
  readonly byOwner: boolean;
}

/**
 * rebuild dropped everything it knows how to drop in the managed schema, but
 * objects are left (e.g. members of an extension that lives elsewhere), or
 * grants on the schema that only their grantor can revoke (e.g. the owner's,
 * when the deploy role doesn't own the schema). The transaction rolled back:
 * nothing changed.
 */
export class WipeFailedError extends SuperDeployError {
  readonly code = "wipe-failed";
  readonly target: string;
  readonly schema: string;
  /** PostgreSQL's descriptions of what is left, e.g. `function public.f(integer)`. */
  readonly objects: readonly string[];
  /** The grants on the schema left, which the deploy role can't revoke. */
  readonly grants: readonly UnrevokedGrant[];

  constructor(
    target: string,
    schema: string,
    objects: readonly string[],
    grants: readonly UnrevokedGrant[] = [],
  ) {
    const left = [
      ...(objects.length > 0
        ? [`it still holds ${objects.join(", ")}; drop them by hand`]
        : []),
      ...(grants.length > 0
        ? [
            `the deploy role can't revoke ${grants.map(unrevokedGrant).join(", ")}; revoke them as their grantor`,
          ]
        : []),
    ];
    super(
      `Could not wipe schema ${schema} on target ${target}: ${left.join("; ")}, then run rebuild again (nothing changed)`,
    );
    this.target = target;
    this.schema = schema;
    this.objects = objects;
    this.grants = grants;
  }
}

function unrevokedGrant(grant: UnrevokedGrant): string {
  const who = grant.byOwner
    ? `${grant.grantor}, the schema's owner: only the owner`
    : `${grant.grantor}: only ${grant.grantor}`;
  return `${grant.privilege} to ${grant.grantee} (granted by ${who} or a superuser can revoke it)`;
}

/** A command was given a migration number the repo has no finalized migration for. */
export class UnknownMigrationError extends SuperDeployError {
  readonly code = "unknown-migration";
  readonly number: number;
  /** The repo's newest migration number; undefined when there is none. */
  readonly newest: number | undefined;

  constructor(number: number, newest: number | undefined) {
    super(
      `There is no finalized migration ${number}${newest === undefined ? " (there are none yet)" : ` (the newest is ${newest})`}`,
    );
    this.number = number;
    this.newest = newest;
  }
}

/**
 * The target's recorded migrations or disposable flag changed between showing
 * them and taking the lock. Nothing changed; run the command again.
 */
export class TargetChangedError extends SuperDeployError {
  readonly code = "target-changed";
  readonly command: GuardedCommand;
  readonly target: string;

  constructor(command: GuardedCommand, target: string) {
    super(
      `Target ${target} changed while ${command} waited for YES (its recorded migrations, deployed draft or disposable flag): nothing changed; run ${command} again to see the new details`,
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
  readonly code = "commit-outcome-unknown";
  readonly target: string;
  readonly attemptId: number;

  constructor(target: string, attemptId: number, options?: ErrorOptions) {
    const cause = options?.cause;
    const reason =
      cause === undefined
        ? ""
        : ` (${cause instanceof Error ? cause.message : String(cause)})`;
    super(
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
  readonly code = "target-drifted";
  readonly target: string;
  /** Sorted by object; never empty. */
  readonly objects: readonly DriftedObject[];

  constructor(target: string, objects: readonly DriftedObject[]) {
    super(
      `Target ${target} has drifted from its recorded migrations: ${listedDrift(objects)}. Deployments refuse until it matches them again (status --target ${target} lists the differences)`,
    );
    this.target = target;
    this.objects = objects;
  }
}

/** The target records migrations the project doesn't have, so no replica of it can be built. */
export class UnknownRecordedMigrationError extends SuperDeployError {
  readonly code = "unknown-recorded-migration";
  readonly target: string;
  readonly numbers: readonly number[];

  constructor(target: string, numbers: readonly number[]) {
    super(
      `Target ${target} records migration${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}, which the project doesn't have`,
    );
    this.target = target;
    this.numbers = numbers;
  }
}

/** `mark` found no pending migration on the target: there is nothing to record. */
export class NothingToMarkError extends SuperDeployError {
  readonly code = "nothing-to-mark";
  readonly target: string;

  constructor(target: string) {
    super(
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
  readonly code = "history-mismatch";
  readonly target: string;
  /** Never empty. */
  readonly mismatches: readonly HistoryMismatch[];

  constructor(target: string, mismatches: readonly HistoryMismatch[]) {
    super(
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
  readonly code = "mark-mismatch";
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
    super(
      `Target ${target} does not match a replica of its migrations up to ${migration}: ${listedDrift(objects)}. Nothing was recorded; fix the target until it matches, then mark again`,
    );
    this.target = target;
    this.migration = migration;
    this.objects = objects;
  }
}

/**
 * `init --adopt` needs a project with no migrations, draft or desired
 * schema yet, and a target that records no migrations; nothing was written.
 */
export class AdoptConflictError extends SuperDeployError {
  readonly code = "adopt-conflict";
  readonly target: string;
  /** Each reason, e.g. `the project already has a draft`. */
  readonly reasons: readonly string[];

  constructor(target: string, reasons: readonly string[]) {
    super(`Cannot adopt target ${target}: ${reasons.join("; ")}`);
    this.target = target;
    this.reasons = reasons;
  }
}

/** Something V1 doesn't support, found by `init --adopt`. */
export interface UnsupportedObject {
  /**
   * The object as PostgreSQL describes it (`statistics object st`), or the
   * first line of the statement the target's schema needs.
   */
  readonly object: string;
  /** The rule id that refuses it, e.g. `unsupported-object`. */
  readonly rule: string;
  /** Why, in the rules' words. */
  readonly reason: string;
}

/**
 * `init --adopt` found objects in the target's managed schema that V1
 * doesn't support (or can't reproduce); nothing was written anywhere.
 */
export class AdoptUnsupportedError extends SuperDeployError {
  readonly code = "adopt-unsupported";
  readonly target: string;
  /** Every one found; never empty. */
  readonly objects: readonly UnsupportedObject[];
  /**
   * With an override-reason callback: the objects that break only risk
   * rules, whose reasons will be asked once nothing else is refused (they
   * aren't in `objects`). Empty without the callback.
   */
  readonly overridesNeeded: readonly OverrideNeeded[];

  constructor(
    target: string,
    objects: readonly UnsupportedObject[],
    overridesNeeded: readonly OverrideNeeded[] = [],
  ) {
    const shown = objects
      .slice(0, 5)
      .map((o) => o.object)
      .join("; ");
    const more = objects.length > 5 ? `; and ${objects.length - 5} more` : "";
    const later =
      overridesNeeded.length === 0
        ? ""
        : `. Once nothing else is refused, an override reason will be asked for ${overridesNeeded.map((needed) => needed.object).join(", ")}`;
    super(
      `Cannot adopt target ${target}: its managed schema has ${objects.length} thing${objects.length === 1 ? "" : "s"} V1 doesn't support: ${shown}${more}. Nothing was written; change the target first, then adopt again${later}`,
    );
    this.target = target;
    this.objects = objects;
    this.overridesNeeded = overridesNeeded;
  }
}

/**
 * `init --adopt` asked for an override reason and got none (an empty
 * answer); nothing was written anywhere.
 */
export class AdoptCancelledError extends SuperDeployError {
  readonly code = "adopt-cancelled";
  readonly target: string;
  /** What the reason was asked for, e.g. `function load_staging(text)`. */
  readonly object: string;

  constructor(target: string, object: string) {
    super(
      `Adoption of target ${target} cancelled: no override reason given for ${object}. Nothing was written`,
    );
    this.target = target;
    this.object = object;
  }
}
