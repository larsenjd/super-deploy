// Replaying migrations: every migration's deploy-time SQL files, in order,
// in ONE transaction with the pinned session settings, exactly as a
// deployment of all of them would run (ADR-0001). Each file's statements run
// one at a time, split by the rules' parser (sql-analysis/parse.ts), so a
// failure names the file and line, which a batch's runtime errors don't
// carry; each migration ends at a boundary (runUnit).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";
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
import { inPinnedTransaction } from "./throwaway.ts";

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
 * Rehearsals only: deployments use runUnit.
 */
export async function replay(
  session: Session,
  units: readonly ReplayUnit[],
  managedSchema: string,
): Promise<void> {
  await inPinnedTransaction(session, managedSchema, async () => {
    for (const unit of units) {
      await runUnit(session, unit);
    }
  });
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
    postgresMessage: error instanceof Error ? error.message : String(error),
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

/** A deployment's transaction rolled back because a file failed. */
export interface DeploymentRollback {
  readonly target: string;
  /** Folder of the newest migration the target records, e.g. `00003-add-email`; undefined when it records none. */
  readonly lastRecorded: string | undefined;
  /** Number of the finalized migration whose file failed. */
  readonly migration: number;
}

/**
 * PostgreSQL refused a deploy-time SQL file, in a rehearsal or a deployment.
 * The message adds a next step by SQLSTATE: the target setting behind a lock
 * (55P03) or statement (57014) timeout, and for a data error (classes 22,
 * 23) in a deployment, a Recovery of the failing migration.
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
  /** Set when a deployment rolled back. */
  readonly rollback: DeploymentRollback | undefined;

  constructor(
    failure: SqlFileFailure,
    options?: ErrorOptions & { rollback?: DeploymentRollback | undefined },
  ) {
    const rollback = options?.rollback;
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
        rollback === undefined
          ? undefined
          : `The deployment rolled back: target ${rollback.target} is unchanged, ${rollback.lastRecorded === undefined ? "with no migration recorded" : `still at migration ${rollback.lastRecorded}`}.`,
        nextStep(failure.sqlState, rollback),
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
  }

  /** The same failure, reported by a deployment that rolled back. */
  rolledBack(rollback: DeploymentRollback): SqlFileFailedError {
    return new SqlFileFailedError(this, { cause: this.cause, rollback });
  }
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function nextStep(
  sqlState: string | undefined,
  rollback: DeploymentRollback | undefined,
): string | undefined {
  if (sqlState === "55P03") {
    return "The target's lockTimeout (default 5s) ran out waiting for a lock: retry once whatever held the lock has finished.";
  }
  if (sqlState === "57014") {
    return "The target's statementTimeout (default none) cancelled the statement: retry once whatever held it up has finished, or raise the setting.";
  }
  if (
    rollback !== undefined &&
    (sqlState?.startsWith("22") === true || sqlState?.startsWith("23") === true)
  ) {
    return `Next: super-deploy recovery --migration ${rollback.migration}, with seed data that reproduces the problem rows in the rehearsal.`;
  }
  return undefined;
}
