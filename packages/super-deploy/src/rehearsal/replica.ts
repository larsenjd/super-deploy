// A replica of a target: a throwaway database created with the target's
// encoding, locale and collation provider, holding exactly what the target's
// recorded migrations should have produced. The drift check (status, deploy)
// compares it with the target; the deployment rehearsal then runs the
// pending migrations on the same database; `mark` (ticket 20) builds one up
// to migration N and requires an empty diff.
import type { DatabaseRequest, Session } from "../adapters/types.ts";
import type { RecordedMigration } from "../deploy/history.ts";
import { UnknownRecordedMigrationError } from "../errors.ts";
import type { Project } from "../project.ts";
import type { FinalizedMigration } from "../store/migrations.ts";
import { type ReplayUnit, replay } from "./replay.ts";
import { ensureManagedSchema, withThrowawayDatabase } from "./throwaway.ts";

/** A finalized migration with its deploy-time files read. */
export interface MigrationWithUnit extends FinalizedMigration {
  /** The original variant's deploy-time files. */
  readonly unit: ReplayUnit;
}

/**
 * The units that rebuild a target's recorded migrations, in number order:
 * each recorded migration's own files from the project.
 *
 * Ticket 17: replay each recorded migration with its RECORDED variant
 * (`recorded.recovery`: undefined = original, K = Recovery K), not the
 * newest one. This is the one place that picks the variant.
 */
export function replicaUnits(
  target: string,
  migrations: readonly MigrationWithUnit[],
  recorded: readonly RecordedMigration[],
): ReplayUnit[] {
  const byNumber = new Map(migrations.map((m) => [m.number, m] as const));
  const unknown = recorded.filter((r) => !byNumber.has(r.number));
  if (unknown.length > 0) {
    throw new UnknownRecordedMigrationError(
      target,
      unknown.map((r) => r.number),
    );
  }
  return recorded.map((r) => {
    const migration = byNumber.get(r.number) as MigrationWithUnit;
    return migration.unit;
  });
}

/**
 * Builds a replica (the managed schema, then `units` replayed in one
 * transaction) on a throwaway database matching `request`, runs `use` on it,
 * and drops it whatever happens.
 */
export function withReplica<T>(
  project: Project,
  request: DatabaseRequest,
  units: readonly ReplayUnit[],
  use: (replica: Session) => Promise<T>,
): Promise<T> {
  const { rehearsal, managedSchema } = project.config;
  return withThrowawayDatabase(rehearsal, request, async (replica) => {
    await ensureManagedSchema(replica, managedSchema);
    if (units.length > 0) {
      await replay(replica, units, managedSchema);
    }
    return use(replica);
  });
}
