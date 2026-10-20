// A draft rehearsal: load the desired schema into one throwaway database;
// replay every finalized migration plus the draft into another; require an
// empty diff from both pg-delta and our own pg_catalog comparison.
import { pgDeltaDiffer } from "../differ/pg-delta.ts";
import { RehearsalMismatchError } from "../errors.ts";
import type { Project } from "../project.ts";
import type { ParsedStatement } from "../sql-analysis/parse.ts";
import { catalogDifferences } from "../verification/catalog.ts";
import { type ReplayUnit, replay } from "./replay.ts";
import {
  draftDatabaseRequest,
  ensureManagedSchema,
  loadDesiredSchema,
  withThrowawayDatabase,
} from "./throwaway.ts";

export interface DraftRehearsal {
  /** `server_version` of the rehearsal server that replayed the migrations. */
  readonly serverVersion: string;
}

export async function rehearseDraft(
  project: Project,
  desiredSchema: readonly ParsedStatement[],
  units: readonly ReplayUnit[],
): Promise<DraftRehearsal> {
  const { config } = project;
  return withThrowawayDatabase(
    config.rehearsal,
    draftDatabaseRequest,
    async (desired) => {
      await loadDesiredSchema(
        desired,
        desiredSchema,
        config.managedSchema,
        config.externalSchemas,
      );
      return withThrowawayDatabase(
        config.rehearsal,
        draftDatabaseRequest,
        async (replayed) => {
          await ensureManagedSchema(replayed, config.managedSchema);
          await replay(replayed, units, config.managedSchema);
          const differences = [
            ...(await pgDeltaDiffer.diff(replayed, desired)).map(
              (statement) => `pg-delta: ${statement.sql}`,
            ),
            ...(
              await catalogDifferences(replayed, desired, config.managedSchema)
            ).map((line) => `catalog: ${line}`),
          ];
          if (differences.length > 0) {
            throw new RehearsalMismatchError(differences);
          }
          return { serverVersion: await replayed.serverVersion() };
        },
      );
    },
  );
}
