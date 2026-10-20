// `status --target X`: what a deployment to the target would do. Read-only:
// one session, no lock, nothing written (a target without a history schema
// simply has every migration pending). It reports the deploy pre-flight's
// findings. Tickets 12 and 14 add drift and settling attempts whose COMMIT
// outcome was lost.
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
import { connectTarget, resolveTarget } from "../deploy/target.ts";
import type { Project } from "../project.ts";
import { readMigrationUnits } from "../rehearsal/replay.ts";
import { verifiedMigrations } from "../store/integrity.ts";
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
    const recorded = await readRecordedMigrations(session, schema);
    const pending = pendingMigrations(withUnits, recorded);
    const preflight = await preflightChecks(session, project, {
      targetName: target.name,
      migrations,
      recorded,
      pending: pending.map((migration) => migration.unit),
    });
    return {
      target: target.name,
      historySchemaExists: await historySchemaExists(session, schema),
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
    };
  } finally {
    await session.close().catch(() => {});
  }
}
