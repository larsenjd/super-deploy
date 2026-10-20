// A draft rehearsal: load the desired schema into one throwaway database
// (and again in another valid order, to prove the result doesn't depend on
// order); replay every finalized migration plus the draft into another;
// require the same structure from both (rehearsal/same-structure.ts).
import type { Project } from "../project.ts";
import type { ParsedStatement } from "../sql-analysis/index.ts";
import { checkOrderIndependence } from "./order-independence.ts";
import { type ReplayUnit, replay } from "./replay.ts";
import { requireSameStructure } from "./same-structure.ts";
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
      await checkOrderIndependence({
        rehearsal: config.rehearsal,
        request: draftDatabaseRequest,
        managedSchema: config.managedSchema,
        statements: desiredSchema,
        loaded: desired,
      });
      return withThrowawayDatabase(
        config.rehearsal,
        draftDatabaseRequest,
        async (replayed) => {
          await ensureManagedSchema(replayed, config.managedSchema);
          await replay(replayed, units, config.managedSchema);
          await requireSameStructure(replayed, desired, config.managedSchema);
          return { serverVersion: await replayed.serverVersion() };
        },
      );
    },
  );
}
