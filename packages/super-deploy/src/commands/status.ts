// `status --target X`: what a deployment to the target would do. One session,
// no lock. It writes only to settle attempts whose outcome was never recorded
// (`settleAttempts`: a lost COMMIT, a command that died); a target without a
// history schema is not written to and simply has every migration pending.
// Tickets 12-13 add drift and pre-flight findings.
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
import { connectTarget, resolveTarget } from "../deploy/target.ts";
import type { Project } from "../project.ts";
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
}

export async function status(
  project: Project,
  options: StatusOptions,
): Promise<StatusReport> {
  const { root, paths, config } = project;
  const target = resolveTarget(project, options.target);
  const migrations = await verifiedMigrations(root, paths);
  const session = await connectTarget(target);
  try {
    const schema = config.historySchema;
    const exists = await historySchemaExists(session, schema);
    if (exists) {
      await settleAttempts(session, schema);
    }
    const recorded = await readRecordedMigrations(session, schema);
    return {
      target: target.name,
      historySchemaExists: exists,
      recorded,
      pending: pendingMigrations(migrations, recorded).map(
        ({ number, name, folder }) => ({ number, name, folder }),
      ),
      attempts: await readRecentAttempts(
        session,
        schema,
        options.attempts ?? 10,
      ),
      disposable: (await readTargetSettings(session, schema)).disposable,
    };
  } finally {
    await session.close().catch(() => {});
  }
}
