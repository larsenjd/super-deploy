// Replaying migrations: every migration's deploy-time SQL files, in order,
// in ONE transaction with the pinned session settings, exactly as a
// deployment of all of them would run (ADR-0001). Each file's statements run
// one at a time, split by the rules' parser (sql-analysis/parse.ts), so a
// failure names the file and line, which a batch's runtime errors don't
// carry; each migration ends at a boundary (runUnit).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../adapters/types.ts";
import {
  durationText,
  type ResolvedConfig,
  targetDefaults,
} from "../config/config.ts";
import { errorReason, SuperDeployError, sessionEnding } from "../errors.ts";
import { parseSqlFile } from "../sql-analysis/parse.ts";
import { decodeHashedText } from "../store/hashing.ts";
import { projectRelative } from "../store/layout.ts";
import {
  deployTimeFileNames,
  exists,
  type FinalizedMigration,
  type FinalizedRecovery,
  schemaChangeFileName,
} from "../store/migrations.ts";
import { inPinnedTransaction, missingFromRehearsals } from "./throwaway.ts";

/** The schemas a rehearsal replays in: the managed one, and the external ones it lacks. */
export type RehearsalSchemas = Pick<
  ResolvedConfig,
  "managedSchema" | "externalSchemas"
>;

export interface DeployTimeFile {
  /** Project-relative path with forward slashes, for messages. */
  readonly file: string;
  readonly sql: string;
}

/** One migration (or the draft) as the ordered SQL files it runs. */
export interface ReplayUnit {
  /** e.g. `00001-add-customers` or `draft add-customers`. */
  readonly label: string;
  readonly files: readonly DeployTimeFile[];
}

/**
 * The deploy-time SQL files a migration or draft folder holds, in the order
 * they run. For a Recovery folder, `schemaChangeFolder` is its migration's
 * folder: a Recovery runs its own scripts around its migration's schema
 * change.
 */
export async function readReplayUnit(
  root: string,
  folder: string,
  label: string,
  schemaChangeFolder: string = folder,
): Promise<ReplayUnit> {
  const files: DeployTimeFile[] = [];
  for (const name of deployTimeFileNames) {
    const absolute = join(
      name === schemaChangeFileName ? schemaChangeFolder : folder,
      name,
    );
    if (await exists(absolute)) {
      const file = projectRelative(root, absolute);
      files.push({
        file,
        sql: decodeHashedText(await readFile(absolute), file),
      });
    }
  }
  return { label, files };
}

/** e.g. `00002-require-email recovery 1`. */
export function recoveryLabel(
  migration: FinalizedMigration,
  recovery: FinalizedRecovery,
): string {
  return `${migration.folder} ${recovery.folder.replace("-", " ")}`;
}

/** A finalized Recovery's deploy-time files: its scripts around its migration's schema change. */
export function readRecoveryUnit(
  root: string,
  migration: FinalizedMigration,
  recovery: FinalizedRecovery,
): Promise<ReplayUnit> {
  return readReplayUnit(
    root,
    recovery.path,
    recoveryLabel(migration, recovery),
    migration.path,
  );
}

/**
 * Every finalized migration as a replay unit, in order, each as its NEWEST
 * variant (its newest Recovery, else the original). Structure is the same
 * whichever variant runs, so rehearsals of the draft replay these.
 */
export async function readMigrationUnits(
  root: string,
  migrations: readonly FinalizedMigration[],
): Promise<ReplayUnit[]> {
  const units: ReplayUnit[] = [];
  for (const migration of migrations) {
    const newest = migration.recoveries.at(-1);
    units.push(
      newest === undefined
        ? await readReplayUnit(root, migration.path, migration.folder)
        : await readRecoveryUnit(root, migration, newest),
    );
  }
  return units;
}

/**
 * Runs every unit's files in one transaction, committing only if all succeed.
 * Rehearsals only: deployments use runUnit. A file failing on something in
 * an external schema says rehearsals don't contain it (ticket 186).
 */
export async function replay(
  session: Session,
  units: readonly ReplayUnit[],
  schemas: RehearsalSchemas,
): Promise<void> {
  try {
    await inPinnedTransaction(session, schemas.managedSchema, async () => {
      for (const unit of units) {
        await runUnit(session, unit);
      }
    });
  } catch (error) {
    throw error instanceof SqlFileFailedError
      ? error.inRehearsal(schemas.externalSchemas)
      : error;
  }
}

/**
 * Runs one unit's files inside the caller's transaction, statement by
 * statement so a failure names the file and line. Shared by rehearsals and deployments
 * (deploy/engine.ts), so both run deploy-time SQL identically.
 *
 * Each unit ends at a migration boundary, which behaves like the COMMIT the
 * migration would get if deployed on its own: deferred constraints are
 * checked (`SET CONSTRAINTS ALL IMMEDIATE`; a violation is blamed on the
 * unit's last file), and the migration's `ON COMMIT DROP` staging tables are
 * dropped (`DISCARD TEMP`), so the next migration may reuse their names.
 * Deferrable constraints then stay immediate for the rest of the transaction.
 *
 * An error saying the session is gone (`sessionEnding`: terminated, shut
 * down, connection lost) is no refusal of the file: it is thrown as it is,
 * for the command to report (deploy/session-ended.ts).
 */
export async function runUnit(
  session: Session,
  unit: ReplayUnit,
): Promise<void> {
  for (const { file, sql } of unit.files) {
    await runFile(session, file, sql);
  }
  const last = unit.files.at(-1);
  if (last !== undefined) {
    try {
      await session.execute("SET CONSTRAINTS ALL IMMEDIATE");
    } catch (error) {
      if (sessionEnding(error) !== undefined) {
        throw error;
      }
      const refusal = refusalOf(error);
      throw new SqlFileFailedError(
        {
          file: last.file,
          line: undefined,
          ...refusal,
          postgresMessage: `deferred constraints checked at the end of the migration: ${refusal.postgresMessage}`,
        },
        { cause: error },
      );
    }
    await session.execute("DISCARD TEMP");
  }
}

async function runFile(
  session: Session,
  file: string,
  sql: string,
): Promise<void> {
  for (const statement of await statementsOf(file, sql)) {
    try {
      await session.execute(statement.text);
    } catch (error) {
      if (sessionEnding(error) !== undefined) {
        throw error;
      }
      const within = lineAt(
        statement.text,
        (error as { position?: string }).position,
      );
      throw new SqlFileFailedError(
        {
          file,
          line:
            within === undefined
              ? statement.line
              : (statement.line ?? 1) - 1 + within,
          ...refusalOf(error),
        },
        { cause: error },
      );
    }
  }
}

/**
 * A file's statements, each with the line it starts on, split by the
 * parser the rules use. A file the parser refuses runs as one batch with no
 * line, so PostgreSQL reports the syntax error itself.
 */
async function statementsOf(
  file: string,
  sql: string,
): Promise<{ readonly line: number | undefined; readonly text: string }[]> {
  const parsed = await parseSqlFile({ path: file, text: sql });
  return parsed.ok
    ? parsed.statements.map(({ line, text }) => ({ line, text }))
    : [{ line: undefined, text: sql }];
}

/** What PostgreSQL said in refusing a statement: node-postgres' error fields. */
function refusalOf(error: unknown): PostgresRefusal {
  const fields = error as {
    detail?: unknown;
    hint?: unknown;
    code?: unknown;
  };
  const text = (value: unknown) =>
    typeof value === "string" && value !== "" ? value : undefined;
  return {
    postgresMessage: errorReason(error),
    detail: text(fields.detail),
    hint: text(fields.hint),
    sqlState: text(fields.code),
  };
}

/**
 * The 1-based line of PostgreSQL's 1-based character `position`, which is
 * relative to the statement sent. Some errors (e.g. a missing index column)
 * carry no position.
 */
function lineAt(
  text: string,
  position: string | undefined,
): number | undefined {
  const index = Number(position);
  if (!(index > 0)) {
    return undefined;
  }
  return (
    1 +
    Array.from(text)
      .slice(0, index - 1)
      .filter((character) => character === "\n").length
  );
}

/** What PostgreSQL said in refusing a statement. */
export interface PostgresRefusal {
  /** PostgreSQL's own message. */
  readonly postgresMessage: string;
  /** PostgreSQL's DETAIL, e.g. `Key (slug)=(a) already exists.` */
  readonly detail: string | undefined;
  /** PostgreSQL's HINT. */
  readonly hint: string | undefined;
  /** The SQLSTATE, e.g. `23505`; undefined when the error carries none. */
  readonly sqlState: string | undefined;
}

/** A refused statement: where it is and what PostgreSQL said. */
export interface SqlFileFailure extends PostgresRefusal {
  /** Project-relative path with forward slashes. */
  readonly file: string;
  /** 1-based line of the error (its statement's first line when PostgreSQL gave no position). */
  readonly line: number | undefined;
}

/**
 * A command's transaction on a target rolled back because a file failed: what
 * the error then says about the target, and the next step it suggests.
 */
export type TargetRollback =
  | DeploymentRollback
  | DraftDeploymentRollback
  | RebuildRollback;

/** A deployment's transaction rolled back. */
export interface DeploymentRollback {
  readonly command: "deploy";
  readonly target: string;
  /** Folder of the newest migration the target records, e.g. `00003-add-email`; undefined when it records none. */
  readonly lastRecorded: string | undefined;
  /** Number of the finalized migration whose file failed. */
  readonly migration: number;
}

/** deploy-draft's transaction rolled back: the target holds no draft. */
export interface DraftDeploymentRollback {
  readonly command: "deploy-draft";
  readonly target: string;
  /** Folder of the newest migration the target records; undefined when it records none. */
  readonly lastRecorded: string | undefined;
  /** Whether the draft's seed data ran first (`--with-seed`). */
  readonly seedData: boolean;
}

/** rebuild's transaction rolled back: nothing was wiped. */
export interface RebuildRollback {
  readonly command: "rebuild";
  readonly target: string;
}

/**
 * E.g. `target qa is unchanged, still at migration 00009-add-tier`, or `...,
 * with no migration recorded`: how a rolled-back deployment's target is
 * described, here and by the CLI after an interruption.
 */
export function unchangedTarget(
  target: string,
  lastRecorded: string | undefined,
): string {
  return `target ${target} is unchanged, ${lastRecorded === undefined ? "with no migration recorded" : `still at migration ${lastRecorded}`}`;
}

/**
 * PostgreSQL refused a deploy-time SQL file, in a rehearsal or a deployment.
 * Reported by a command whose transaction on a target rolled back
 * (`rolledBack`), it says so and what the target is still at. The message
 * adds a next step by SQLSTATE: the target setting behind a lock (55P03) or
 * statement (57014) timeout; for a data error (classes 22, 23), a Recovery of
 * the failing migration in a deployment, or fixing the draft in deploy-draft
 * (QA 174); for a type change a generated column blocks (0A000 with its
 * DETAIL), the pre-migration fix; and for a statement a forced row-level
 * security policy would filter (42501, refused under the pinned
 * `row_security = off`), turning FORCE off while deploying. In a rehearsal, a
 * missing object in a declared external schema (inRehearsal) says rehearsals
 * don't contain it.
 */
export class SqlFileFailedError extends SuperDeployError {
  readonly code = "sql-file-failed";
  /** Project-relative path with forward slashes. */
  readonly file: string;
  /** 1-based line of the error (its statement's first line when PostgreSQL gave no position). */
  readonly line: number | undefined;
  readonly postgresMessage: string;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
  readonly sqlState: string | undefined;
  /** Set when a command's transaction on a target rolled back. */
  readonly rollback: TargetRollback | undefined;
  /** The declared external schema a rehearsal failed for lack of. */
  private readonly missingExternalSchema: string | undefined;

  constructor(
    failure: SqlFileFailure,
    options?: ErrorOptions & {
      rollback?: TargetRollback | undefined;
      missingExternalSchema?: string | undefined;
    },
  ) {
    const rollback = options?.rollback;
    const missingExternalSchema = options?.missingExternalSchema;
    super(
      [
        sentence(
          `${failure.file}${failure.line === undefined ? "" : `:${failure.line}`}: PostgreSQL refused it: ${failure.postgresMessage}`,
        ),
        failure.detail === undefined
          ? undefined
          : sentence(`Detail: ${failure.detail}`),
        failure.hint === undefined
          ? undefined
          : sentence(`Hint: ${failure.hint}`),
        missingExternalSchema === undefined
          ? undefined
          : `This failed in a rehearsal: it reads ${missingFromRehearsals([missingExternalSchema])}, so a migration's scripts and seed data must not run anything that reads it, such as a trigger on a table they write (see the README, "Permissions").`,
        rollback === undefined ? undefined : rolledBackSentence(rollback),
        nextStep(failure, rollback),
      ]
        .filter((part) => part !== undefined)
        .join(" "),
      options,
    );
    this.file = failure.file;
    this.line = failure.line;
    this.postgresMessage = failure.postgresMessage;
    this.detail = failure.detail;
    this.hint = failure.hint;
    this.sqlState = failure.sqlState;
    this.rollback = rollback;
    this.missingExternalSchema = missingExternalSchema;
  }

  /** The same failure, reported by the command whose transaction rolled back. */
  rolledBack(rollback: TargetRollback): SqlFileFailedError {
    return new SqlFileFailedError(this, {
      cause: this.cause,
      rollback,
      missingExternalSchema: this.missingExternalSchema,
    });
  }

  /**
   * The same failure in a rehearsal, saying so when PostgreSQL found
   * something missing in one of `externalSchemas`, which rehearsals don't
   * contain.
   */
  inRehearsal(externalSchemas: readonly string[]): SqlFileFailedError {
    const schema = externalSchemaNamed(this, externalSchemas);
    return schema === undefined
      ? this
      : new SqlFileFailedError(this, {
          cause: this.cause,
          rollback: this.rollback,
          missingExternalSchema: schema,
        });
  }
}

/** SQLSTATEs of an undefined table, function, type or schema. */
const undefinedObject = new Set(["42P01", "42883", "42704", "3F000"]);

/**
 * The external schema PostgreSQL's message names in refusing a missing
 * object: `relation "auth.users"`, `function auth.uid()`, `schema "auth"`.
 * Schema names are plain lowercase identifiers (config.ts).
 */
function externalSchemaNamed(
  failure: SqlFileFailure,
  externalSchemas: readonly string[],
): string | undefined {
  if (!undefinedObject.has(failure.sqlState ?? "")) {
    return undefined;
  }
  return externalSchemas.find((schema) =>
    new RegExp(`(?:^|[\\s"(])${schema}(?:\\.|"(?:\\s|$))`).test(
      failure.postgresMessage,
    ),
  );
}

/** E.g. `The deployment rolled back: target qa is unchanged, still at migration 00003-add-email.` */
function rolledBackSentence(rollback: TargetRollback): string {
  switch (rollback.command) {
    case "deploy":
      return `The deployment rolled back: ${unchangedTarget(rollback.target, rollback.lastRecorded)}.`;
    case "deploy-draft":
      return `The draft's deployment rolled back: ${unchangedTarget(rollback.target, rollback.lastRecorded)} (no draft deployed).`;
    case "rebuild":
      return `The rebuild rolled back: target ${rollback.target} is unchanged.`;
  }
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function nextStep(
  failure: SqlFileFailure,
  rollback: TargetRollback | undefined,
): string | undefined {
  const { sqlState } = failure;
  const generated = generatedColumnBlocking(failure);
  if (generated !== undefined) {
    return `Next: drop generated column "${generated.generated}" in the pre-migration script and run draft again: the schema change then changes the type of "${generated.column}" and adds "${generated.generated}" back (see the README, "Changing the type of a column a generated column uses").`;
  }
  const forced = forcedRowSecurityTable(failure);
  if (forced !== undefined) {
    return `Next: table "${forced}" has FORCE ROW LEVEL SECURITY on the target, so its policies apply to the deploy role and would hide rows from this migration: turn it off while deploying (ALTER TABLE ... NO FORCE ROW LEVEL SECURITY, then FORCE again afterwards), or move the work out of the migration.`;
  }
  if (sqlState === "55P03") {
    return `The target's lockTimeout (default ${durationText(targetDefaults.lockTimeoutMs)}) ran out waiting for a lock: retry once whatever held the lock has finished.`;
  }
  if (sqlState === "57014") {
    const { statementTimeoutMs } = targetDefaults;
    const statementDefault =
      statementTimeoutMs === undefined
        ? "none"
        : durationText(statementTimeoutMs);
    return `The target's statementTimeout (default ${statementDefault}) cancelled the statement: retry once whatever held it up has finished, or raise the setting.`;
  }
  if (
    sqlState?.startsWith("22") === true ||
    sqlState?.startsWith("23") === true
  ) {
    return dataErrorStep(rollback);
  }
  return undefined;
}

/**
 * What to do about a data error: a Recovery for a deployment's finalized
 * migration; the draft itself for deploy-draft (it isn't finalized). None
 * for rebuild (it replays what other targets ran) or a rehearsal.
 */
function dataErrorStep(
  rollback: TargetRollback | undefined,
): string | undefined {
  switch (rollback?.command) {
    case "deploy":
      return `Next: super-deploy recovery --migration ${rollback.migration}, with seed data that reproduces the problem rows in the rehearsal.`;
    case "deploy-draft":
      return `Next: fix the draft's scripts${rollback.seedData ? " or its seed data" : ""}, then run deploy-draft again.`;
    default:
      return undefined;
  }
}

/**
 * The columns in PostgreSQL's refusal to change the type of a column a
 * stored generated column uses (pg-delta's type change leaves the generated
 * column in place: research §8), read from its DETAIL.
 */
function generatedColumnBlocking(
  failure: SqlFileFailure,
): { readonly column: string; readonly generated: string } | undefined {
  if (failure.sqlState !== "0A000") {
    return undefined;
  }
  const match = /^Column "(.+)" is used by generated column "(.+)"\.$/.exec(
    failure.detail ?? "",
  );
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { column: match[1], generated: match[2] };
}

/**
 * The table in PostgreSQL's refusal of a statement that row-level security
 * would filter while `row_security` is off.
 */
function forcedRowSecurityTable(failure: SqlFileFailure): string | undefined {
  if (failure.sqlState !== "42501") {
    return undefined;
  }
  return /^query would be affected by row-level security policy for table "(.+)"$/.exec(
    failure.postgresMessage,
  )?.[1];
}
