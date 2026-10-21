// `status --target X`: what a deployment to the target would do. One session,
// no lock. It writes only to settle attempts whose outcome was never recorded
// (`settleAttempts`: a lost COMMIT, a command that died); a target without a
// history schema is not written to and simply has every migration pending. It
// reports the deploy pre-flight's findings (including a draft deploy-draft
// left on the target, a history mismatch), and drift: the target's managed
// schema compared with a replica of its recorded migrations, built on a
// throwaway database matching its locale (the CLI exits 1 on drift). Drift is
// not checked while the history mismatches, a deployed draft included, nor
// while another command holds the target lock: a deploy transaction's locks
// would block the catalog read until the lock timeout, so status names the
// holder (`lockHolder`, as deploy's refusal does) and reports the rest.
import { settleAttempts } from "../deploy/attempts.ts";
import {
  type AttemptRecord,
  type DeployedDraft,
  type RecordedMigration,
  readDeployedDraft,
  readRecentAttempts,
  readRecordedMigrations,
  readTargetSettings,
  schemaExists,
} from "../deploy/history.ts";
import { type LockHolder, lockHolder } from "../deploy/lock.ts";
import { pendingMigrations } from "../deploy/pending.ts";
import {
  type PreflightFindings,
  preflightChecks,
} from "../deploy/preflight.ts";
import {
  connectTarget,
  resolveTarget,
  targetDatabaseRequest,
} from "../deploy/target.ts";
import type { Project } from "../project.ts";
import {
  newestVariant,
  readMigrationsWithUnits,
  replicaUnits,
  withReplica,
} from "../rehearsal/replica.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { type DriftedObject, driftBetween } from "../verification/drift.ts";
import { type DeployedMigration, deployedMigration } from "./deploy.ts";

export interface StatusOptions {
  /** The target's name in config. */
  target: string;
  /** How many recent attempts to list. Default 10. */
  attempts?: number;
}

export interface StatusReport {
  readonly target: string;
  /** False until the target's first deployment (or other recorded command). */
  readonly historySchemaExists: boolean;
  /** What the target's history schema records, in number order. */
  readonly recorded: readonly RecordedMigration[];
  /** The project's migrations the target has not recorded, in the order a deployment applies them. */
  readonly pending: readonly DeployedMigration[];
  /** The newest attempts first. */
  readonly attempts: readonly AttemptRecord[];
  readonly disposable: boolean;
  /**
   * The draft deploy-draft left on the target, if any: the target's structure
   * is then no longer that of its recorded migrations, and a deployment
   * refuses (it is also one of `preflight.historyMismatches`) until rebuild.
   */
  readonly draft: DeployedDraft | undefined;
  /** What the deploy pre-flight finds now; a deployment would refuse on anything but warnings. */
  readonly preflight: PreflightFindings;
  /**
   * How the target's managed schema differs from what its recorded
   * migrations produce (column order and ownership aside: ownership is
   * `preflight.notOwned`). Empty: no drift.
   * Undefined when not checked: see `driftNotChecked`.
   */
  readonly drift: readonly DriftedObject[] | undefined;
  /**
   * Why drift wasn't checked: `history-mismatch` when the recorded history
   * doesn't match the project's migrations (`preflight.historyMismatches`),
   * so no replica can be built; `target-locked` when another command holds
   * the target lock (`lockedBy`). Undefined when drift was checked.
   */
  readonly driftNotChecked: "history-mismatch" | "target-locked" | undefined;
  /** Who holds the target lock (a running deploy, mark, rebuild...), if anyone. */
  readonly lockedBy: LockHolder | undefined;
}

export async function status(
  project: Project,
  options: StatusOptions,
): Promise<StatusReport> {
  const { root, paths, config } = project;
  const target = resolveTarget(project, options.target);
  const migrations = await verifiedMigrations(root, paths);
  const withUnits = await readMigrationsWithUnits(root, migrations);
  const session = await connectTarget(target);
  try {
    const schema = config.historySchema;
    const exists = await schemaExists(session, schema);
    if (exists) {
      await settleAttempts(session, schema);
    }
    const recorded = await readRecordedMigrations(session, schema);
    const pending = pendingMigrations(withUnits, recorded);
    const preflight = await preflightChecks(session, project, {
      targetName: target.name,
      migrations,
      recorded,
    });
    const holder = await lockHolder(session, schema);
    const lockedBy = holder.pid === undefined ? undefined : holder;
    const driftNotChecked =
      preflight.historyMismatches.length > 0
        ? "history-mismatch"
        : lockedBy !== undefined
          ? "target-locked"
          : undefined;
    const drift =
      driftNotChecked !== undefined
        ? undefined
        : await withReplica(
            project,
            await targetDatabaseRequest(session),
            replicaUnits(target.name, withUnits, recorded),
            (replica) =>
              driftBetween(session, replica, config.managedSchema, {
                target,
              }),
          );
    return {
      target: target.name,
      historySchemaExists: exists,
      recorded,
      // Each as the variant a deployment would run: its newest.
      pending: pending.map((migration) =>
        deployedMigration(migration, newestVariant(migration).recovery),
      ),
      attempts: await readRecentAttempts(
        session,
        schema,
        options.attempts ?? 10,
      ),
      disposable: (await readTargetSettings(session, schema)).disposable,
      draft: await readDeployedDraft(session, schema),
      preflight,
      drift,
      driftNotChecked,
      lockedBy,
    };
  } finally {
    await session.close().catch(() => {});
  }
}
