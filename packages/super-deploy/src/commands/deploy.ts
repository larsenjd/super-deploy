// `deploy --target X`: apply every pending migration to the target in one
// transaction, after rehearsing them on a throwaway database that matches the
// target's locale. Sequence (spec "Deployment engine"): open attempt → lock →
// pre-flight (deploy/preflight.ts) → [drift check, ticket 12] → rehearse the
// pending migrations → one transaction on the target → close attempt.

import { applyMigrations, withLockedTarget } from "../deploy/engine.ts";
import { readRecordedMigrations } from "../deploy/history.ts";
import { pendingMigrations } from "../deploy/pending.ts";
import { preflightChecks, refusesDeployment } from "../deploy/preflight.ts";
import { targetDatabaseRequest } from "../deploy/target.ts";
import { PreflightFailedError } from "../errors.ts";
import type { Project } from "../project.ts";
import { rehearseDeployment } from "../rehearsal/rehearse-deployment.ts";
import { readMigrationUnits } from "../rehearsal/replay.ts";
import { verifiedMigrations } from "../store/integrity.ts";

export interface DeployOptions {
  /** The target's name in config. */
  target: string;
  /**
   * Called with each warning as it is found, e.g. that the deploy role is a
   * superuser. Warnings never stop the deployment.
   */
  onWarning?: ((warning: string) => void) | undefined;
}

export interface DeployedMigration {
  readonly number: number;
  readonly name: string;
  /** e.g. `00001-add-customers`. */
  readonly folder: string;
}

export interface DeployResult {
  readonly target: string;
  /** The attempt recorded in the target's history schema. */
  readonly attemptId: number;
  /** The migrations this deployment applied, in order; empty when the target was up to date. */
  readonly deployed: readonly DeployedMigration[];
}

export async function deploy(
  project: Project,
  options: DeployOptions,
): Promise<DeployResult> {
  const { root, paths, config } = project;
  const migrations = await verifiedMigrations(root, paths);
  const units = await readMigrationUnits(root, migrations);
  const deployable = migrations.map((migration, index) => ({
    ...migration,
    unit: units[index] ?? { label: migration.folder, files: [] },
  }));

  return withLockedTarget(
    project,
    options.target,
    "deploy",
    async ({ target, session, attempt }) => {
      const recorded = await readRecordedMigrations(
        session,
        config.historySchema,
      );
      const pending = pendingMigrations(deployable, recorded);
      const findings = await preflightChecks(session, project, {
        targetName: target.name,
        migrations,
        recorded,
        pending: pending.map((migration) => migration.unit),
      });
      for (const warning of findings.warnings) {
        options.onWarning?.(warning);
      }
      if (refusesDeployment(findings)) {
        throw new PreflightFailedError(target.name, findings);
      }
      const result = {
        target: target.name,
        attemptId: attempt.id,
        deployed: pending.map(({ number, name, folder }) => ({
          number,
          name,
          folder,
        })),
      };
      const [first] = pending;
      const last = pending.at(-1);
      if (first === undefined || last === undefined) {
        return result;
      }
      await attempt.setRange(first.number, last.number);

      await rehearseDeployment(
        project,
        await targetDatabaseRequest(session),
        deployable
          .filter((migration) => migration.number < first.number)
          .map((migration) => migration.unit),
        pending.map((migration) => migration.unit),
      );

      await applyMigrations(
        session,
        pending.map((migration) => ({
          number: migration.number,
          name: migration.name,
          contentHash: migration.contentHash,
          chainHash: migration.chainHash,
          recovery: undefined,
          unit: migration.unit,
        })),
        {
          managedSchema: config.managedSchema,
          historySchema: config.historySchema,
          target,
          attemptId: attempt.id,
        },
      );
      return result;
    },
  );
}
