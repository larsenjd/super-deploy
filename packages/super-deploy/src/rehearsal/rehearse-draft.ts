// A draft rehearsal: load the desired schema into one throwaway database
// (and again in another valid order, to prove the result doesn't depend on
// order); replay every finalized migration plus the draft into another;
// require the same structure from both (rehearsal/same-structure.ts).
//
// A mismatch says "run draft again" only when that can help: when the
// desired schema changed since `draft` generated the schema change. When it
// hasn't, re-drafting regenerates the same schema change, so the message
// names what does cause it (draftMismatchSubject): a hand edit of the schema
// change, or else the causes `draft`'s own check names
// (schema-change-check.ts): a change pg-delta can't generate, or the
// pre-migration script when there is one.
import type { Project } from "../project.ts";
import type { ParsedStatement } from "../sql-analysis/index.ts";
import { loadDesiredSchemaCheckingOrder } from "./order-independence.ts";
import { type ReplayUnit, replay } from "./replay.ts";
import {
  requireSameStructure,
  type StructuralDifferences,
} from "./same-structure.ts";
import { mismatchCauses } from "./schema-change-check.ts";
import {
  draftDatabaseRequest,
  ensureManagedSchema,
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
  since: SinceDraft,
): Promise<DraftRehearsal> {
  const { config } = project;
  return withThrowawayDatabase(
    config.rehearsal,
    draftDatabaseRequest,
    async (desired) => {
      await loadDesiredSchemaCheckingOrder(config, desired, desiredSchema);
      return withThrowawayDatabase(
        config.rehearsal,
        draftDatabaseRequest,
        async (replayed) => {
          await ensureManagedSchema(replayed, config.managedSchema);
          await replay(replayed, units, config.managedSchema);
          await requireSameStructure(replayed, desired, config.managedSchema, {
            subject: (found) =>
              draftMismatchSubject(since, found, config.managedSchema),
          });
          return { serverVersion: await replayed.serverVersion() };
        },
      );
    },
  );
}

/** What changed since `draft` last generated the schema change. */
export interface SinceDraft {
  /** The desired schema's hash differs from the one `draft` stored (or none is stored). */
  readonly desiredSchemaChanged: boolean;
  /**
   * The schema change's project-relative path when it differs from the one
   * `draft` wrote; undefined when it doesn't, or no hash of it is stored.
   */
  readonly editedSchemaChange: string | undefined;
  /** The draft has a pre-migration script. */
  readonly preMigrationScript: boolean;
}

/**
 * The opening of a draft rehearsal's mismatch, or undefined for the default
 * ("run draft again"), which is right when the desired schema changed.
 */
function draftMismatchSubject(
  since: SinceDraft,
  found: StructuralDifferences,
  managedSchema: string,
): string | undefined {
  if (since.desiredSchemaChanged) {
    return undefined;
  }
  if (since.editedSchemaChange !== undefined) {
    return `The rehearsal does not match the desired schema: ${since.editedSchemaChange} was edited by hand since draft generated it, and the edited schema change doesn't produce the desired schema (run draft again to regenerate it)`;
  }
  const causes = mismatchCauses(found, managedSchema, since);
  return `The rehearsal does not match the desired schema, and running draft again won't change that: ${causes.join("; and ")}`;
}
