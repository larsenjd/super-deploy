// A deployment rehearsal: before a deployment touches its target, build a
// replica of the target on a throwaway database created with the target's
// encoding, locale and collation provider, then run the pending migrations on
// it exactly as the deployment will (one transaction, the same files in the
// same order, the same pinned settings).
//
// Ticket 12 extends this: compare the replica of the recorded migrations with
// the target (drift) before running the pending ones, and compare the result
// with the newest migration's desired-schema snapshot afterwards.
import type { DatabaseRequest } from "../adapters/types.ts";
import type { Project } from "../project.ts";
import { type ReplayUnit, replay } from "./replay.ts";
import { ensureManagedSchema, withThrowawayDatabase } from "./throwaway.ts";

export interface DeploymentRehearsal {
  /** `server_version` of the rehearsal server. */
  readonly serverVersion: string;
}

export async function rehearseDeployment(
  project: Project,
  request: DatabaseRequest,
  recorded: readonly ReplayUnit[],
  pending: readonly ReplayUnit[],
): Promise<DeploymentRehearsal> {
  const { rehearsal, managedSchema } = project.config;
  return withThrowawayDatabase(rehearsal, request, async (replica) => {
    await ensureManagedSchema(replica, managedSchema);
    if (recorded.length > 0) {
      // The target as its recorded migrations should have left it.
      await replay(replica, recorded, managedSchema);
    }
    await replay(replica, pending, managedSchema);
    return { serverVersion: await replica.serverVersion() };
  });
}
