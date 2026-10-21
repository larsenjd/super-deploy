// Marking: recording a target's next pending migration as deployed without
// running it, because someone already brought the target there by hand. Only
// when the target's managed schema matches, with no exceptions, a replica of
// its migrations up to that one (column order and ownership aside, as in the
// drift check; `mark` and adoption check ownership on their own,
// deploy/ownership.ts). The record is the migration's original variant, marked
// rather than deployed, and is the only thing written: one `migrations` row
// in the target's history schema, inside its own transaction.
//
// The guarded `mark` command (commands/mark.ts) and `init --adopt` (ticket
// 22, which records migration 1 this way from `init`, without the guard) both
// use `markNextPending` under `withLockedTarget`.
//
// SQL `recordMarked` sends on the command session (fault-injection wrappers
// match on these): execute("BEGIN"), execute(<SET LOCAL statements, including
// lock_timeout, joined by ";\n">), query(INSERT INTO <history>.migrations
// ...), execute("COMMIT") (or "ROLLBACK" after a failure before it). Because
// it writes a `migrations` row with the attempt's id, a lost COMMIT or a
// crashed mark settles like a deployment: succeeded if the row is there.

import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { SuperDeployError } from "../errors.ts";
import type { Project } from "../project.ts";
import {
  type MigrationWithUnit,
  readMigrationsWithUnits,
  replicaUnits,
  withReplica,
} from "../rehearsal/replica.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import {
  type DriftedObject,
  driftBetween,
  listedDrift,
} from "../verification/drift.ts";
import { inDeployTransaction, type LockedTarget } from "./engine.ts";
import {
  type DeployedDraft,
  type RecordedMigration,
  readDeployedDraft,
  readRecordedMigrations,
  recordMigration,
} from "./history.ts";
import { pendingMigrations } from "./pending.ts";
import type { HistoryMismatch } from "./preflight.ts";
import { heldDraft, historyMismatches } from "./preflight.ts";
import { targetDatabaseRequest } from "./target.ts";

/**
 * The project's finalized migrations with their deploy-time files, after the
 * integrity check (MigrationIntegrityError), so read before connecting.
 */
export async function readMarkableMigrations(
  project: Project,
): Promise<MigrationWithUnit[]> {
  return readMigrationsWithUnits(
    project.root,
    await verifiedMigrations(project.root, project.paths),
  );
}

/**
 * The target's next pending migration: the only one `mark` may record.
 * Refuses with HistoryMismatchError if what the target records doesn't match
 * the project (no faithful replica could be built) or the target holds a
 * deployed draft, and NothingToMarkError if nothing is pending.
 */
export function nextToMark(
  targetName: string,
  migrations: readonly MigrationWithUnit[],
  recorded: readonly RecordedMigration[],
  draft: DeployedDraft | undefined,
): MigrationWithUnit {
  const mismatches = historyMismatches(migrations, recorded, draft);
  if (mismatches.length > 0) {
    const onlyDraft =
      draft !== undefined &&
      mismatches.every((mismatch) => mismatch.reason === "draft");
    throw new HistoryMismatchError(
      targetName,
      mismatches,
      onlyDraft ? heldDraft(draft, recorded) : undefined,
    );
  }
  const [next] = pendingMigrations(migrations, recorded);
  if (next === undefined) {
    throw new NothingToMarkError(targetName);
  }
  return next;
}

/**
 * The replica check: builds a replica of the target's recorded migrations
 * (each with its recorded variant) plus `next` (its original scripts) on a
 * throwaway database with the target's locale, and requires the target's
 * managed schema to match it exactly, column order and ownership aside.
 * Throws MarkMismatchError listing the differences. Only reads the target
 * (its catalogs, under its lock and statement timeouts).
 */
export async function requireReplicaMatch(
  project: Project,
  target: ResolvedTarget,
  session: Session,
  input: {
    readonly migrations: readonly MigrationWithUnit[];
    readonly recorded: readonly RecordedMigration[];
    readonly next: MigrationWithUnit;
  },
): Promise<void> {
  const units = [
    ...replicaUnits(target.name, input.migrations, input.recorded),
    input.next.unit,
  ];
  const differences = await withReplica(
    project,
    await targetDatabaseRequest(session),
    units,
    (replica) =>
      driftBetween(session, replica, project.config.managedSchema, {
        target,
      }),
  );
  if (differences.length > 0) {
    throw new MarkMismatchError(target.name, input.next.folder, differences);
  }
}

/**
 * Records `migration` as marked (original variant) for the locked target's
 * attempt, in a transaction of its own that writes nothing else.
 */
export async function recordMarked(
  project: Project,
  locked: LockedTarget,
  migration: MigrationWithUnit,
): Promise<void> {
  const { session, target, attempt } = locked;
  const { managedSchema, historySchema } = project.config;
  await inDeployTransaction(
    session,
    { managedSchema, historySchema, target, attemptId: attempt.id },
    () =>
      recordMigration(session, historySchema, {
        number: migration.number,
        name: migration.name,
        contentHash: migration.contentHash,
        chainHash: migration.chainHash,
        recovery: undefined,
        attemptId: attempt.id,
        recordedHow: "marked",
      }),
  );
}

/**
 * Marks the locked target's next pending migration: reads what it records
 * (under the lock), picks the next pending migration (`nextToMark`), sets
 * the attempt's range to it, runs the replica check (`requireReplicaMatch`)
 * and records it as marked (`recordMarked`). Returns the migration marked.
 *
 * No guard: the caller decides who may do this. `mark` asks for YES first;
 * `init --adopt` (ticket 22) calls it directly from `init`.
 */
export async function markNextPending(
  project: Project,
  locked: LockedTarget,
  migrations: readonly MigrationWithUnit[],
): Promise<MigrationWithUnit> {
  const recorded = await readRecordedMigrations(
    locked.session,
    project.config.historySchema,
  );
  const next = nextToMark(
    locked.target.name,
    migrations,
    recorded,
    await readDeployedDraft(locked.session, project.config.historySchema),
  );
  await locked.attempt.setRange([next]);
  await requireReplicaMatch(project, locked.target, locked.session, {
    migrations,
    recorded,
    next,
  });
  await recordMarked(project, locked, next);
  return next;
}

/** `mark` found no pending migration on the target: there is nothing to record. */
export class NothingToMarkError extends SuperDeployError {
  readonly code = "nothing-to-mark";
  readonly target: string;

  constructor(target: string) {
    super(
      `Target ${target} has no pending migration to mark: it records every migration in the project`,
    );
    this.target = target;
  }
}

/**
 * What the target records disagrees with the project's migrations (see
 * HistoryMismatch), so no faithful replica of it can be built. Nothing changed.
 * When the only mismatch is a deployed draft (`heldDraft`, its description),
 * the recorded migrations themselves match, so the message leads with the
 * draft instead.
 */
export class HistoryMismatchError extends SuperDeployError {
  readonly code = "history-mismatch";
  readonly target: string;
  /** Never empty. */
  readonly mismatches: readonly HistoryMismatch[];

  constructor(
    target: string,
    mismatches: readonly HistoryMismatch[],
    heldDraft?: string,
  ) {
    super(
      heldDraft === undefined
        ? `Target ${target}'s recorded migrations don't match the project's: ${mismatches.map((m) => m.message).join("; ")}`
        : `Target ${target} holds ${heldDraft}`,
    );
    this.target = target;
    this.mismatches = mismatches;
  }
}

/**
 * `mark` refused: the target's managed schema differs from a replica of its
 * migrations up to the one being marked (column order and ownership aside).
 * Nothing was recorded.
 */
export class MarkMismatchError extends SuperDeployError {
  readonly code = "mark-mismatch";
  readonly target: string;
  /** The migration that was to be marked, e.g. `00002-add-orders`. */
  readonly migration: string;
  /** How the target differs from the replica, sorted by object; never empty. */
  readonly objects: readonly DriftedObject[];

  constructor(
    target: string,
    migration: string,
    objects: readonly DriftedObject[],
  ) {
    super(
      `Target ${target} does not match a replica of its migrations up to ${migration}: ${listedDrift(objects)}. Nothing was recorded; fix the target until it matches, then mark again`,
    );
    this.target = target;
    this.migration = migration;
    this.objects = objects;
  }
}
