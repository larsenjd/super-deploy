// A deployment rehearsal: before a deployment touches its target, build a
// replica of the target on a throwaway database created with the target's
// encoding, locale and collation provider (rehearsal/replica.ts), and:
//   1. drift check: compare the replica with the target; any structural
//      difference refuses (DriftError), no exceptions
//   2. run the pending migrations on the same replica exactly as the
//      deployment will (one transaction, the same files in the same order,
//      the same pinned settings)
//   3. require the result to match the newest migration's desired-schema
//      snapshot, loaded into a second throwaway database with the same
//      request (rehearsal/same-structure.ts, as in draft rehearsals)
import type { DatabaseRequest, Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { DriftError } from "../errors.ts";
import type { Project } from "../project.ts";
import type { ParsedStatement } from "../sql-analysis/index.ts";
import { driftBetween } from "../verification/drift.ts";
import { type ReplayUnit, replay } from "./replay.ts";
import { withReplica } from "./replica.ts";
import { requireSameStructure } from "./same-structure.ts";
import { loadDesiredSchema, withThrowawayDatabase } from "./throwaway.ts";

export interface DeploymentRehearsalInput {
  /** The target, for messages and its timeouts. */
  readonly targetConfig: ResolvedTarget;
  /** A session to the target, read here (catalogs only). */
  readonly target: Session;
  /** The target's encoding, locale and collation provider. */
  readonly request: DatabaseRequest;
  /** What rebuilds the target's recorded migrations (`replicaUnits`). */
  readonly recorded: readonly ReplayUnit[];
  /** The pending migrations' units, in the order the deployment runs them; may be empty. */
  readonly pending: readonly ReplayUnit[];
  /**
   * The newest migration's desired-schema snapshot, ordered for loading,
   * with the migration's folder for messages. Called only when something is
   * pending.
   */
  readonly snapshot: () => Promise<{
    readonly folder: string;
    readonly statements: readonly ParsedStatement[];
  }>;
}

export interface DeploymentRehearsal {
  /** `server_version` of the rehearsal server. */
  readonly serverVersion: string;
}

export async function rehearseDeployment(
  project: Project,
  input: DeploymentRehearsalInput,
): Promise<DeploymentRehearsal> {
  const { rehearsal, managedSchema, externalSchemas } = project.config;
  return withReplica(
    project,
    input.request,
    input.recorded,
    async (replica) => {
      const drift = await driftBetween(input.target, replica, managedSchema, {
        target: input.targetConfig,
      });
      if (drift.length > 0) {
        throw new DriftError(input.targetConfig.name, drift);
      }
      if (input.pending.length > 0) {
        await replay(replica, input.pending, managedSchema);
        const snapshot = await input.snapshot();
        await withThrowawayDatabase(
          rehearsal,
          input.request,
          async (desired) => {
            await loadDesiredSchema(
              desired,
              snapshot.statements,
              managedSchema,
              externalSchemas,
            );
            await requireSameStructure(
              replica,
              desired,
              managedSchema,
              `The deployment rehearsal does not match the desired-schema snapshot of ${snapshot.folder}`,
            );
          },
        );
      }
      return { serverVersion: await replica.serverVersion() };
    },
  );
}
