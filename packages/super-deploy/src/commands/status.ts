// `status --target X`: what a deployment to the target would do. One session,
// no lock. It writes only to settle attempts whose outcome was never recorded
// (`settleAttempts`: a lost COMMIT, a command that died); a target without a
// history schema is not written to and simply has every migration pending. It
// reports the deploy pre-flight's findings, and drift: the target's managed
// schema compared with a replica of its recorded migrations, built on a
// throwaway database matching its locale (the CLI exits 1 on drift).
import { settleAttempts } from "../deploy/attempts.ts";
import {
  type AttemptRecord,
  historySchemaExists,
  type RecordedMigration,
  readRecentAttempts,
  readRecordedMigrations,
  readTargetSettings,
} from "../deploy/history.ts";
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
import { readMigrationUnits } from "../rehearsal/replay.ts";
import { replicaUnits, withReplica } from "../rehearsal/replica.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { type DriftedObject, driftBetween } from "../verification/drift.ts";
import type { DeployedMigration } from "./deploy.ts";

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
  /** What the deploy pre-flight finds now; a deployment would refuse on anything but warnings. */
  readonly preflight: PreflightFindings;
  /**
   * How the target's managed schema differs from what its recorded
   * migrations produce (column order and ownership aside). Empty: no drift.
   * Undefined when the recorded history doesn't match the project's
   * migrations (`preflight.historyMismatches`), so no replica can be built.
   */
  readonly drift: readonly DriftedObject[] | undefined;
}

export async function status(
  project: Project,
  options: StatusOptions,
): Promise<StatusReport> {
  const { root, paths, config } = project;
  const target = resolveTarget(project, options.target);
  const migrations = await verifiedMigrations(root, paths);
  const units = await readMigrationUnits(root, migrations);
  const withUnits = migrations.map((migration, index) => ({
    ...migration,
    unit: units[index] ?? { label: migration.folder, files: [] },
  }));
  const session = await connectTarget(target);
  try {
    const schema = config.historySchema;
    const exists = await historySchemaExists(session, schema);
    if (exists) {
      await settleAttempts(session, schema);
    }
    const recorded = await readRecordedMigrations(session, schema);
    const pending = pendingMigrations(withUnits, recorded);
    const preflight = await preflightChecks(session, project, {
      targetName: target.name,
      migrations,
      recorded,
      pending: pending.map((migration) => migration.unit),
    });
    const drift =
      preflight.historyMismatches.length > 0
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
      pending: pending.map(({ number, name, folder }) => ({
        number,
        name,
        folder,
      })),
      attempts: await readRecentAttempts(
        session,
        schema,
        options.attempts ?? 10,
      ),
      disposable: (await readTargetSettings(session, schema)).disposable,
      preflight,
      drift,
    };
  } finally {
    await session.close().catch(() => {});
  }
}
