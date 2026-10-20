// `rehearse`: replay every finalized migration plus the draft on a throwaway
// database and prove the result matches the desired schema, without
// finalizing anything.
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  NoDraftError,
  RecoverySchemaChangeEditedError,
  UnknownMigrationError,
} from "../errors.ts";
import type { Project } from "../project.ts";
import { rehearseDraft } from "../rehearsal/rehearse-draft.ts";
import { rehearseRecovery } from "../rehearsal/rehearse-recovery.ts";
import { readMigrationUnits, readReplayUnit } from "../rehearsal/replay.ts";
import {
  readSeededUnit,
  seededFiles,
  seededUnits,
} from "../rehearsal/seed-data.ts";
import {
  analyseDesiredSchema,
  type DestructiveStatement,
  type LockWarning,
  type MigrationAnalysis,
  type Override,
} from "../sql-analysis/index.ts";
import {
  asSqlFiles,
  readDesiredSchema,
  readDesiredSchemaFiles,
} from "../store/desired-schema.ts";
import { type DraftMetadata, readDraft } from "../store/draft.ts";
import { type HashedFile, normaliseLineEndings } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { projectRelative } from "../store/layout.ts";
import {
  type FinalizedMigration,
  schemaChangeFileName,
  snapshotFolderName,
} from "../store/migrations.ts";
import { newestSnapshot, refuseRuleViolations } from "./check-rules.ts";

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
  const draft = await readDraft(paths);
  if (draft === undefined) {
    throw new NoDraftError(action);
  }
  const migrations = await verifiedMigrations(root, paths);
  if (draft.recoveryOf !== undefined) {
    return rehearseRecoveryDraft(project, draft, migrations, beforeRehearsal);
  }
  const desiredSchema = await readDesiredSchemaFiles(root, paths.desiredSchema);
  const statements = await analyseDesiredSchema(
    asSqlFiles(root, paths.desiredSchema, desiredSchema),
    {
      managedSchema: project.config.managedSchema,
      externalSchemas: project.config.externalSchemas,
    },
  );
  const units = await readMigrationUnits(root, migrations);
  // The draft's seed data loads just before its pre-migration script; the
  // finalized migrations' seed data is never loaded.
  const seeded = await readSeededUnit(root, paths.draft, `draft ${draft.name}`);
  const previous = await newestSnapshot(root, migrations);
  const analysis = await refuseRuleViolations(seededFiles(seeded), {
    managedSchema: project.config.managedSchema,
    externalSchemas: project.config.externalSchemas,
    schemas: [previous, statements],
    previous,
  });
  await beforeRehearsal?.(draft, analysis);
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

/**
 * A Recovery draft of migration N: its schema change must still be N's; the
 * rules apply to all its files as they run (seed data, scripts, N's schema
 * change); then the rehearsal proves it ends in N's original structure.
 * Destructive statements, warnings and overrides are the Recovery's own: the
 * schema change's were acknowledged and recorded with N.
 */
async function rehearseRecoveryDraft(
  project: Project,
  draft: DraftMetadata,
  migrations: readonly FinalizedMigration[],
  beforeRehearsal:
    | ((draft: DraftMetadata, analysis: MigrationAnalysis) => Promise<void>)
    | undefined,
): Promise<RehearsedDraft> {
  const { root, paths, config } = project;
  const number = draft.recoveryOf as number;
  const migration = migrations[number - 1];
  if (migration === undefined) {
    throw new UnknownMigrationError(number, migrations.at(-1)?.number);
  }
  await requireOriginalSchemaChange(project, migration);
  const earlier = migrations.slice(0, number - 1);
  const seeded = await readSeededUnit(
    root,
    paths.draft,
    `Recovery draft of ${migration.folder}`,
  );
  const previous = await newestSnapshot(root, earlier);
  const full = await refuseRuleViolations(seededFiles(seeded), {
    managedSchema: config.managedSchema,
    externalSchemas: config.externalSchemas,
    schemas: [
      previous,
      await readDesiredSchema(root, join(migration.path, snapshotFolderName)),
    ],
    previous,
  });
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
    before: await readMigrationUnits(root, earlier),
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

/** Refuses a Recovery draft whose schema-change.sql is no longer its migration's (line endings aside). */
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
  if ((await read(project.paths.draftSchemaChange)) !== original) {
    throw new RecoverySchemaChangeEditedError(file, migration.folder);
  }
}
