// `deploy --target X`: apply every pending migration to the target in one
// transaction, after rehearsing them on a throwaway database that matches the
// target's locale. Sequence (spec "Deployment engine"): open attempt → lock →
// pre-flight (deploy/preflight.ts) → drift check → rehearse the pending
// migrations on the drift replica and require a match with the newest
// snapshot → one transaction on the target → close attempt. Pre-flight and
// drift check run even when nothing is pending.

import { join } from "node:path";
import { applyMigrations, withLockedTarget } from "../deploy/engine.ts";
import { readRecordedMigrations } from "../deploy/history.ts";
import { pendingMigrations } from "../deploy/pending.ts";
import { preflightChecks, refusesDeployment } from "../deploy/preflight.ts";
import { targetDatabaseRequest } from "../deploy/target.ts";
import { PreflightFailedError } from "../errors.ts";
import type { Project } from "../project.ts";
import { rehearseDeployment } from "../rehearsal/rehearse-deployment.ts";
import {
  type MigrationWithUnit,
  newestVariant,
  readMigrationsWithUnits,
  replicaUnits,
} from "../rehearsal/replica.ts";
import { analyseDesiredSchema } from "../sql-analysis/index.ts";
import { readDesiredSchema } from "../store/desired-schema.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { snapshotFolderName } from "../store/migrations.ts";

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
  const deployable = await readMigrationsWithUnits(root, migrations);

  return withLockedTarget(
    project,
    options.target,
    "deploy",
    async ({ target, session, attempt }) => {
      const recorded = await readRecordedMigrations(
        session,
        config.historySchema,
      );
      // Each pending migration runs its newest variant.
      const pending = pendingMigrations(deployable, recorded).map(
        (migration) => ({ ...migration, ...newestVariant(migration) }),
      );
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
      if (first !== undefined && last !== undefined) {
        await attempt.setRange(first.number, last.number);
      }

      await rehearseDeployment(project, {
        targetConfig: target,
        target: session,
        request: await targetDatabaseRequest(session),
        recorded: replicaUnits(target.name, deployable, recorded),
        pending: pending.map((migration) => migration.unit),
        snapshot: async () => {
          const newest = deployable.at(-1) as MigrationWithUnit;
          const files = await readDesiredSchema(
            root,
            join(newest.path, snapshotFolderName),
          );
          return {
            folder: newest.folder,
            statements: await analyseDesiredSchema(files, {
              managedSchema: config.managedSchema,
              externalSchemas: config.externalSchemas,
            }),
          };
        },
      });
      if (pending.length === 0) {
        return result;
      }

      await applyMigrations(
        session,
        pending.map((migration) => ({
          number: migration.number,
          name: migration.name,
          contentHash: migration.contentHash,
          chainHash: migration.chainHash,
          recovery: migration.recovery,
          recoveryChainHash: migration.recoveryChainHash,
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
