// A Recovery draft's rehearsal: prove that migration N run with the Recovery
// ends in exactly the structure migration N's original ends in, so every
// target that records N has the same structure whichever variant it ran.
//
// Two throwaway databases, each with migrations 1..N-1 replayed (newest
// variants: their structure is the same whichever variant runs):
//   original   then migration N's original scripts and schema change
//   recovery   then the Recovery draft's seed data, and its scripts around
//              migration N's schema change
// and the same comparison as a draft rehearsal (pg-delta and our own
// pg_catalog comparison) must find no difference.
import type { Session } from "../adapters/types.ts";
import { pgDeltaDiffer } from "../differ/pg-delta.ts";
import { RehearsalMismatchError } from "../errors.ts";
import type { Project } from "../project.ts";
import { catalogDifferences } from "../verification/catalog.ts";
import { type ReplayUnit, replay } from "./replay.ts";
import {
  draftDatabaseRequest,
  ensureManagedSchema,
  withThrowawayDatabase,
} from "./throwaway.ts";

export interface RecoveryRehearsalInput {
  /** The migration's folder name, for messages. */
  readonly folder: string;
  /** Migrations 1..N-1, in order. */
  readonly before: readonly ReplayUnit[];
  /** Migration N's original variant. */
  readonly original: ReplayUnit;
  /** The Recovery's seed data (if any) and its migration unit. */
  readonly recovery: readonly ReplayUnit[];
}

export async function rehearseRecovery(
  project: Project,
  input: RecoveryRehearsalInput,
): Promise<{ readonly serverVersion: string }> {
  const { rehearsal, managedSchema } = project.config;
  const build = async (session: Session, units: readonly ReplayUnit[]) => {
    await ensureManagedSchema(session, managedSchema);
    await replay(session, units, managedSchema);
  };
  return withThrowawayDatabase(
    rehearsal,
    draftDatabaseRequest,
    async (original) => {
      await build(original, [...input.before, input.original]);
      return withThrowawayDatabase(
        rehearsal,
        draftDatabaseRequest,
        async (recovered) => {
          await build(recovered, [...input.before, ...input.recovery]);
          const differences = [
            ...(await pgDeltaDiffer.diff(recovered, original)).map(
              (statement) => `pg-delta: ${statement.sql}`,
            ),
            ...(
              await catalogDifferences(recovered, original, managedSchema)
            ).map((line) => `catalog: ${line}`),
          ];
          if (differences.length > 0) {
            throw new RehearsalMismatchError(differences, {
              subject: `The Recovery's rehearsal does not end in the same structure as migration ${input.folder}; a Recovery may change only data`,
            });
          }
          return { serverVersion: await recovered.serverVersion() };
        },
      );
    },
  );
}
