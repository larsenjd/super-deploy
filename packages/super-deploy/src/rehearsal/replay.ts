// Replaying migrations: every migration's deploy-time SQL files, in order,
// in ONE transaction with the pinned session settings, exactly as a
// deployment of all of them would run (ADR-0001). Each file is its own batch,
// so a failure names the file; each migration ends at a boundary (runUnit).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";
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
 * Runs one unit's files inside the caller's transaction, each file as its own
 * batch so a failure names the file. Shared by rehearsals and deployments
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
    await runFile(
      session,
      last.file,
      "SET CONSTRAINTS ALL IMMEDIATE",
      "deferred constraints checked at the end of the migration: ",
    );
    await session.execute("DISCARD TEMP");
  }
}

async function runFile(
  session: Session,
  file: string,
  sql: string,
  context = "",
): Promise<void> {
  try {
    await session.execute(sql);
  } catch (error) {
    throw new SqlFileFailedError(
      file,
      context === ""
        ? lineAt(sql, (error as { position?: string }).position)
        : undefined,
      `${context}${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * The 1-based line of PostgreSQL's 1-based character `position`, which is
 * relative to the whole batch. Some errors (e.g. a missing index column)
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
