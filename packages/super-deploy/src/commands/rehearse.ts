// `rehearse`: replay every finalized migration plus the draft on a throwaway
// database and prove the result matches the desired schema, without
// finalizing anything.
import { NoDraftError } from "../errors.ts";
import type { Project } from "../project.ts";
import { rehearseDraft } from "../rehearsal/rehearse-draft.ts";
import { readMigrationUnits, readReplayUnit } from "../rehearsal/replay.ts";
import { analyseDesiredSchema } from "../sql-analysis/index.ts";
import { asSqlFiles, readDesiredSchemaFiles } from "../store/desired-schema.ts";
import { type DraftMetadata, readDraft } from "../store/draft.ts";
import type { HashedFile } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import type { FinalizedMigration } from "../store/migrations.ts";

export interface RehearseResult {
  /** The draft's name. */
  readonly name: string;
  /** How many finalized migrations were replayed before the draft. */
  readonly migrationsReplayed: number;
  /** `server_version` of the rehearsal server. */
  readonly serverVersion: string;
}

export async function rehearse(project: Project): Promise<RehearseResult> {
  const rehearsed = await rehearseCurrentDraft(project, "rehearse");
  return {
    name: rehearsed.draft.name,
    migrationsReplayed: rehearsed.migrations.length,
    serverVersion: rehearsed.serverVersion,
  };
}

export interface RehearsedDraft {
  readonly draft: DraftMetadata;
  readonly migrations: readonly FinalizedMigration[];
  /** The desired schema that was rehearsed, relative to the desired-schema folder. */
  readonly desiredSchema: readonly HashedFile[];
  readonly serverVersion: string;
}

/** Shared by `rehearse` and `finalize`. */
export async function rehearseCurrentDraft(
  project: Project,
  action: string,
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
  );
  const units = await readMigrationUnits(root, migrations);
  units.push(await readReplayUnit(root, paths.draft, `draft ${draft.name}`));
  const { serverVersion } = await rehearseDraft(project, statements, units);
  return { draft, migrations, desiredSchema, serverVersion };
}
