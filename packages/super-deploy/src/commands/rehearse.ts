// `rehearse`: replay every finalized migration plus the draft on a throwaway
// database and prove the result matches the desired schema, without
// finalizing anything.
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Project } from "../project.ts";
import { rehearseDraft } from "../rehearsal/rehearse-draft.ts";
import { rehearseRecovery } from "../rehearsal/rehearse-recovery.ts";
import { readMigrationUnits, readReplayUnit } from "../rehearsal/replay.ts";
import {
  readSeededUnit,
  type SeededUnit,
  seededFiles,
  seededUnits,
} from "../rehearsal/seed-data.ts";
import {
  analyseDesiredSchema,
  type DestructiveStatement,
  type LockWarning,
  type MigrationAnalysis,
  type Override,
  type ParsedStatement,
} from "../sql-analysis/index.ts";
import {
  asSqlFiles,
  readDesiredSchema,
  readDesiredSchemaFiles,
} from "../store/desired-schema.ts";
import {
  type DraftMetadata,
  NoDraftError,
  readDraft,
  recoverySchemaChange,
} from "../store/draft.ts";
import { type HashedFile, normaliseLineEndings } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { projectRelative } from "../store/layout.ts";
import {
  type FinalizedMigration,
  schemaChangeFileName,
  snapshotFolderName,
  UnknownMigrationError,
} from "../store/migrations.ts";
import { newestSnapshot, refuseRuleViolations } from "./check-rules.ts";
import { RecoverySchemaChangeEditedError } from "./recovery.ts";

export interface RehearseResult {
  /** The draft's name. */
  readonly name: string;
  /** For a Recovery draft: the number of the migration it recovers. */
  readonly recoveryOf: number | undefined;
  /** How many finalized migrations were replayed before the draft. */
  readonly migrationsReplayed: number;
  /** `server_version` of the rehearsal server. */
  readonly serverVersion: string;
  /** Statements `finalize` will need acknowledged (draft paths). */
  readonly destructive: readonly DestructiveStatement[];
  /** Statements that rewrite or scan an existing table while holding its lock (draft paths). */
  readonly warnings: readonly LockWarning[];
}

export async function rehearse(project: Project): Promise<RehearseResult> {
  const rehearsed = await rehearseCurrentDraft(project, "rehearse");
  return {
    name: rehearsed.draft.name,
    recoveryOf: rehearsed.recoveryOf?.number,
    migrationsReplayed:
      rehearsed.recoveryOf === undefined
        ? rehearsed.migrations.length
        : rehearsed.recoveryOf.number - 1,
    serverVersion: rehearsed.serverVersion,
    destructive: rehearsed.analysis.destructive,
    warnings: rehearsed.analysis.warnings,
  };
}

export interface RehearsedDraft {
  readonly draft: DraftMetadata;
  readonly migrations: readonly FinalizedMigration[];
  /** For a Recovery draft: the migration it recovers. */
  readonly recoveryOf: FinalizedMigration | undefined;
  /** The desired schema that was rehearsed, relative to the desired-schema folder (empty for a Recovery draft). */
  readonly desiredSchema: readonly HashedFile[];
  readonly serverVersion: string;
  /** The override markers accepted in the draft's deploy-time files. */
  readonly overrides: readonly Override[];
  /** The draft's deploy-time analysis (no violations by now). */
  readonly analysis: MigrationAnalysis;
}

/**
 * Shared by `rehearse` and `finalize`. `beforeRehearsal` runs once the
 * draft has passed the rules, before any database work (finalize asks for
 * the destructive acknowledgement there). A Recovery draft is rehearsed
 * against its migration's original instead of the desired schema.
 */
export async function rehearseCurrentDraft(
  project: Project,
  action: string,
  beforeRehearsal?: (
    draft: DraftMetadata,
    analysis: MigrationAnalysis,
  ) => Promise<void>,
): Promise<RehearsedDraft> {
  const { root, paths } = project;
  const draft = await readDraft(root, paths);
  if (draft === undefined) {
    throw new NoDraftError(action);
  }
  const migrations = await verifiedMigrations(root, paths);
  if (draft.recoveryOf !== undefined) {
    return rehearseRecoveryDraft(project, draft, migrations, beforeRehearsal);
  }
  const { desiredSchema, statements, seeded, analysis } = await checkDraft(
    project,
    draft,
    migrations,
  );
  await beforeRehearsal?.(draft, analysis);
  const units = await readMigrationUnits(root, migrations);
  // The draft's seed data loads just before its pre-migration script; the
  // finalized migrations' seed data is never loaded.
  units.push(...seededUnits(seeded));
  const { serverVersion } = await rehearseDraft(project, statements, units);
  return {
    draft,
    migrations,
    recoveryOf: undefined,
    desiredSchema,
    serverVersion,
    overrides: analysis.overrides,
    analysis,
  };
}

export interface CheckedDraft {
  /** The desired schema, relative to the desired-schema folder. */
  readonly desiredSchema: readonly HashedFile[];
  readonly statements: readonly ParsedStatement[];
  readonly seeded: SeededUnit;
  /** The analysis of the draft's files as they run. */
  readonly analysis: MigrationAnalysis;
}

/**
 * Shared by rehearse, finalize and deploy-draft. The desired schema must pass
 * its rules, and the (non-Recovery) draft's files the deploy-time rules as
 * they run (seed data, scripts, schema change), between the newest snapshot
 * and the desired schema (SqlRuleViolationError).
 */
export async function checkDraft(
  project: Project,
  draft: DraftMetadata,
  migrations: readonly FinalizedMigration[],
): Promise<CheckedDraft> {
  const { root, paths, config } = project;
  const desiredSchema = await readDesiredSchemaFiles(root, paths.desiredSchema);
  const statements = await analyseDesiredSchema(
    asSqlFiles(root, paths.desiredSchema, desiredSchema),
    {
      managedSchema: config.managedSchema,
      externalSchemas: config.externalSchemas,
    },
  );
  const seeded = await readSeededUnit(root, paths.draft, `draft ${draft.name}`);
  const previous = await newestSnapshot(root, migrations);
  const analysis = await refuseRuleViolations(seededFiles(seeded), {
    managedSchema: config.managedSchema,
    externalSchemas: config.externalSchemas,
    schemas: [previous, statements],
    previous,
  });
  return { desiredSchema, statements, seeded, analysis };
}

/**
 * A Recovery draft of migration N: the rules apply to all its files as they
 * run (see `checkRecoveryDraft`); then the rehearsal proves it ends in N's
 * original structure. Destructive statements, warnings and overrides are the
 * Recovery's own: the schema change's were acknowledged and recorded with N.
 */
async function rehearseRecoveryDraft(
  project: Project,
  draft: DraftMetadata,
  migrations: readonly FinalizedMigration[],
  beforeRehearsal:
    | ((draft: DraftMetadata, analysis: MigrationAnalysis) => Promise<void>)
    | undefined,
): Promise<RehearsedDraft> {
  const { root } = project;
  const {
    migration,
    seeded,
    analysis: full,
  } = await checkRecoveryDraft(project, draft, migrations);
  const own = <T extends { file: string }>(items: readonly T[]) =>
    items.filter(({ file }) => posix.basename(file) !== schemaChangeFileName);
  const analysis: MigrationAnalysis = {
    ...full,
    destructive: own(full.destructive),
    warnings: own(full.warnings),
    overrides: own(full.overrides),
  };
  await beforeRehearsal?.(draft, analysis);
  const { serverVersion } = await rehearseRecovery(project, {
    folder: migration.folder,
    before: await readMigrationUnits(
      root,
      migrations.slice(0, migration.number - 1),
    ),
    original: await readReplayUnit(root, migration.path, migration.folder),
    recovery: seededUnits(seeded),
  });
  return {
    draft,
    migrations,
    recoveryOf: migration,
    desiredSchema: [],
    serverVersion,
    overrides: analysis.overrides,
    analysis,
  };
}

export interface CheckedRecoveryDraft {
  /** The migration the draft recovers. */
  readonly migration: FinalizedMigration;
  readonly seeded: SeededUnit;
  /** The analysis of all its files, N's schema change included. */
  readonly analysis: MigrationAnalysis;
}

/**
 * Shared by rehearse, finalize and deploy-draft. A Recovery draft of
 * migration N must name a finalized N (UnknownMigrationError), its schema
 * change must still be N's (RecoverySchemaChangeEditedError), and its files
 * must pass the rules as they run (seed data, scripts, N's schema change),
 * against the snapshots of N-1 and N (SqlRuleViolationError).
 */
export async function checkRecoveryDraft(
  project: Project,
  draft: DraftMetadata,
  migrations: readonly FinalizedMigration[],
): Promise<CheckedRecoveryDraft> {
  const { root, paths, config } = project;
  const number = draft.recoveryOf as number;
  const migration = migrations[number - 1];
  if (migration === undefined) {
    throw new UnknownMigrationError(number, migrations.at(-1)?.number);
  }
  await requireOriginalSchemaChange(project, migration);
  const seeded = await readSeededUnit(
    root,
    paths.draft,
    `Recovery draft of ${migration.folder}`,
  );
  const previous = await newestSnapshot(root, migrations.slice(0, number - 1));
  const analysis = await refuseRuleViolations(seededFiles(seeded), {
    managedSchema: config.managedSchema,
    externalSchemas: config.externalSchemas,
    schemas: [
      previous,
      await readDesiredSchema(root, join(migration.path, snapshotFolderName)),
    ],
    previous,
  });
  return { migration, seeded, analysis };
}

/**
 * Refuses a Recovery draft whose schema-change.sql is no longer its
 * migration's (line endings aside): the copy `recovery` writes, or a
 * verbatim copy (as Recovery drafts made before that header existed hold).
 */
export async function requireOriginalSchemaChange(
  project: Project,
  migration: FinalizedMigration,
): Promise<void> {
  const file = projectRelative(project.root, project.paths.draftSchemaChange);
  const read = (path: string) =>
    readFile(path, "utf8").then(normaliseLineEndings, (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
  const original = await read(join(migration.path, schemaChangeFileName));
  const copy = await read(project.paths.draftSchemaChange);
  if (
    copy === undefined ||
    original === undefined ||
    (copy !== original &&
      copy !== recoverySchemaChange(original, migration.folder))
  ) {
    throw new RecoverySchemaChangeEditedError(file, migration.folder);
  }
}
