// `rehearse`: replay every finalized migration plus the draft on a throwaway
// database and prove the result matches the desired schema, without
// finalizing anything.
import { NoDraftError } from "../errors.ts";
import type { Project } from "../project.ts";
import { rehearseDraft } from "../rehearsal/rehearse-draft.ts";
import { readMigrationUnits, readReplayUnit } from "../rehearsal/replay.ts";
import {
  analyseDesiredSchema,
  type DestructiveStatement,
  type LockWarning,
  type MigrationAnalysis,
} from "../sql-analysis/index.ts";
import { asSqlFiles, readDesiredSchemaFiles } from "../store/desired-schema.ts";
import { type DraftMetadata, readDraft } from "../store/draft.ts";
import type { HashedFile } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import type { FinalizedMigration } from "../store/migrations.ts";
import { newestSnapshot, refuseRuleViolations } from "./check-rules.ts";

export interface RehearseResult {
  /** The draft's name. */
  readonly name: string;
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
    migrationsReplayed: rehearsed.migrations.length,
    serverVersion: rehearsed.serverVersion,
    destructive: rehearsed.analysis.destructive,
    warnings: rehearsed.analysis.warnings,
  };
}

export interface RehearsedDraft {
  readonly draft: DraftMetadata;
  readonly migrations: readonly FinalizedMigration[];
  /** The desired schema that was rehearsed, relative to the desired-schema folder. */
  readonly desiredSchema: readonly HashedFile[];
  readonly serverVersion: string;
  /** The draft's deploy-time analysis (no violations by now). */
  readonly analysis: MigrationAnalysis;
}

/**
 * Shared by `rehearse` and `finalize`. `beforeRehearsal` runs once the
 * draft has passed the rules, before any database work (finalize asks for
 * the destructive acknowledgement there).
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
  const desiredSchema = await readDesiredSchemaFiles(root, paths.desiredSchema);
  const statements = await analyseDesiredSchema(
    asSqlFiles(root, paths.desiredSchema, desiredSchema),
    {
      managedSchema: project.config.managedSchema,
      externalSchemas: project.config.externalSchemas,
    },
  );
  const units = await readMigrationUnits(root, migrations);
  const draftUnit = await readReplayUnit(
    root,
    paths.draft,
    `draft ${draft.name}`,
  );
  const previous = await newestSnapshot(root, migrations);
  const analysis = await refuseRuleViolations(draftUnit, {
    managedSchema: project.config.managedSchema,
    schemas: [previous, statements],
    previous,
  });
  await beforeRehearsal?.(draft, analysis);
  units.push(draftUnit);
  const { serverVersion } = await rehearseDraft(project, statements, units);
  return { draft, migrations, desiredSchema, serverVersion, analysis };
}
