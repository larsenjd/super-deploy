// `rehearse`: replay every finalized migration plus the draft on a throwaway
// database and prove the result matches the desired schema, without
// finalizing anything. The rules check a draft between the newest
// migration's snapshot and the desired schema, and a Recovery draft of
// migration N between the snapshots of N-1 and N; both come from the
// snapshot reader (store/snapshots.ts).
import { join, posix } from "node:path";
import type { Project } from "../project.ts";
import { rehearseDraft } from "../rehearsal/rehearse-draft.ts";
import { rehearseRecovery } from "../rehearsal/rehearse-recovery.ts";
import { readMigrationUnits, readReplayUnit } from "../rehearsal/replay.ts";
import {
  hasPreMigrationScript,
  readSeededUnit,
  type SeededUnit,
  seededFiles,
  seededUnits,
} from "../rehearsal/seed-data.ts";
import {
  type DestructiveStatement,
  desiredSchemaAnalysis,
  type LockWarning,
  type MigrationAnalysis,
  type Override,
  type ParsedStatement,
  type UnqualifiedNameWarning,
} from "../sql-analysis/index.ts";
import { asSqlFiles, readDesiredSchemaFiles } from "../store/desired-schema.ts";
import {
  type DraftMetadata,
  NoDraftError,
  readDraft,
  recoverySchemaChange,
  reportUnknownDraftFiles,
  type UnknownDraftFileOptions,
} from "../store/draft.ts";
import {
  draftSchemaChangeHandEdit,
  type SchemaChangeHandEdit,
} from "../store/hand-edit.ts";
import { desiredSchemaHash, type HashedFile } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { projectRelative } from "../store/layout.ts";
import {
  type FinalizedMigration,
  readNormalisedIfPresent,
  schemaChangeFileName,
  UnknownMigrationError,
} from "../store/migrations.ts";
import {
  type MigrationSnapshots,
  readSnapshot,
  readSnapshots,
} from "../store/snapshots.ts";
import { refuseRuleViolations } from "./check-rules.ts";
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
  /**
   * Project-relative path of the draft's schema change when it was edited by
   * hand since `draft` generated it (store/hand-edit.ts); undefined if not.
   */
  readonly handEdited: string | undefined;
}

export type RehearseOptions = UnknownDraftFileOptions;

export async function rehearse(
  project: Project,
  options: RehearseOptions = {},
): Promise<RehearseResult> {
  const rehearsed = await rehearseCurrentDraft(project, "rehearse", options);
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
    handEdited: rehearsed.handEdit?.file,
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
  /** The hand edit of a (non-Recovery) draft's schema change, if any. */
  readonly handEdit: SchemaChangeHandEdit | undefined;
  /** Desired-schema routines whose bodies name its objects unqualified (none for a Recovery draft). */
  readonly unqualifiedNames: readonly UnqualifiedNameWarning[];
}

export interface RehearseDraftHooks extends UnknownDraftFileOptions {
  /**
   * Runs once the draft has passed the rules, before any database work
   * (finalize asks for the destructive acknowledgement there).
   */
  beforeRehearsal?: (
    draft: DraftMetadata,
    analysis: MigrationAnalysis,
  ) => Promise<void>;
}

/**
 * Shared by `rehearse` and `finalize`. Unknown draft files are reported
 * first, then the rules run, then `beforeRehearsal`, then the rehearsal. A
 * Recovery draft is rehearsed against its migration's original instead of
 * the desired schema.
 */
export async function rehearseCurrentDraft(
  project: Project,
  action: string,
  hooks: RehearseDraftHooks = {},
): Promise<RehearsedDraft> {
  const { root, paths } = project;
  const draft = await readDraft(root, paths);
  if (draft === undefined) {
    throw new NoDraftError(action);
  }
  await reportUnknownDraftFiles(root, paths, hooks);
  const { beforeRehearsal } = hooks;
  const migrations = await verifiedMigrations(root, paths);
  if (draft.recoveryOf !== undefined) {
    return rehearseRecoveryDraft(project, draft, migrations, beforeRehearsal);
  }
  const { desiredSchema, statements, seeded, analysis, unqualifiedNames } =
    await checkDraft(project, draft, migrations);
  await beforeRehearsal?.(draft, analysis);
  const units = await readMigrationUnits(root, migrations);
  // The draft's seed data loads just before its pre-migration script; the
  // finalized migrations' seed data is never loaded.
  units.push(...seededUnits(seeded));
  // Edited by hand: the schema change differs from draft's generated copy
  // (store/hand-edit.ts), for a failing rehearsal as for the warnings.
  const handEdit = await draftSchemaChangeHandEdit(root, paths);
  const { serverVersion } = await rehearseDraft(project, statements, units, {
    desiredSchemaChanged:
      draft.desiredSchemaHash !== desiredSchemaHash(desiredSchema),
    editedSchemaChange: handEdit?.file,
    preMigrationScript: hasPreMigrationScript(seeded),
  });
  return {
    draft,
    migrations,
    recoveryOf: undefined,
    desiredSchema,
    serverVersion,
    overrides: analysis.overrides,
    analysis,
    handEdit,
    unqualifiedNames,
  };
}

export interface CheckedDraft {
  /** The desired schema, relative to the desired-schema folder. */
  readonly desiredSchema: readonly HashedFile[];
  readonly statements: readonly ParsedStatement[];
  readonly seeded: SeededUnit;
  /** The analysis of the draft's files as they run. */
  readonly analysis: MigrationAnalysis;
  /** Desired-schema routines whose bodies name its objects unqualified. */
  readonly unqualifiedNames: readonly UnqualifiedNameWarning[];
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
  const { statements, unqualifiedNames } = await desiredSchemaAnalysis(
    asSqlFiles(root, paths.desiredSchema, desiredSchema),
    {
      managedSchema: config.managedSchema,
      externalSchemas: config.externalSchemas,
    },
  );
  const seeded = await readSeededUnit(root, paths.draft, `draft ${draft.name}`);
  const previous = (await readSnapshot(root, migrations)).sqlFiles;
  const analysis = await refuseRuleViolations(seededFiles(seeded), {
    managedSchema: config.managedSchema,
    externalSchemas: config.externalSchemas,
    schemas: [previous, statements],
    previous,
  });
  return { desiredSchema, statements, seeded, analysis, unqualifiedNames };
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
    handEdit: undefined,
    unqualifiedNames: [],
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
  const { before, after } = (
    await readSnapshots(root, migrations.slice(0, number))
  ).at(-1) as MigrationSnapshots;
  const analysis = await refuseRuleViolations(seededFiles(seeded), {
    managedSchema: config.managedSchema,
    externalSchemas: config.externalSchemas,
    schemas: [before.sqlFiles, after.sqlFiles],
    previous: before.sqlFiles,
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
  const original = await readNormalisedIfPresent(
    join(migration.path, schemaChangeFileName),
  );
  const copy = await readNormalisedIfPresent(project.paths.draftSchemaChange);
  if (
    copy === undefined ||
    original === undefined ||
    (copy !== original &&
      copy !== recoverySchemaChange(original, migration.folder))
  ) {
    throw new RecoverySchemaChangeEditedError(file, migration.folder);
  }
}
