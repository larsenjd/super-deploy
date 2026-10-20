// `rebuild --target X --to N`: resets a disposable target to a known
// migration. A guarded command (guard/guard.ts): terminal-only, YES typed
// exactly, a manual attempt, the target lock.
//
// One deploy transaction on the target (pinned settings, the target's
// timeouts): drop everything in the managed schema (deploy/wipe.ts; the
// schema itself, its privileges and default privileges stay), delete the
// recorded migrations and any deployed draft from the history schema, then
// run migrations 1 to N exactly as a deployment does, recording each as
// deployed by this attempt (each as its newest variant, like a deployment to
// a new target). Seed data is never loaded. The attempt log and
// the disposable flag are kept. Not rehearsed first: the target is
// disposable and the transaction rolls back on any failure.
import {
  inDeployTransaction,
  type MigrationToApply,
  runMigrations,
} from "../deploy/engine.ts";
import { historyTable } from "../deploy/history.ts";
import { TargetNotDisposableError } from "../deploy/target.ts";
import { wipeManagedSchema } from "../deploy/wipe.ts";
import { runGuarded } from "../guard/guard.ts";
import type { Project } from "../project.ts";
import {
  newestVariant,
  readMigrationsWithUnits,
} from "../rehearsal/replica.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import {
  migrationFolderName,
  UnknownMigrationError,
} from "../store/migrations.ts";
import type { DeployedMigration } from "./deploy.ts";

export interface RebuildOptions {
  /** The target's name in config. */
  target: string;
  /** The migration to rebuild up to (inclusive). */
  to: number;
}

export interface RebuildResult {
  readonly target: string;
  /** The migrations replayed onto the wiped target, in order (1 to N). */
  readonly deployed: readonly DeployedMigration[];
  /** The manual attempt that rebuilt it. */
  readonly attemptId: number;
}

/**
 * Terminal-only: shows the target's details at this process's terminal and
 * goes ahead only when the person there types YES. Refuses with
 * TerminalRequiredError in CI or without a terminal on stdin and stdout
 * (before touching the target), and NotConfirmedError for any other answer.
 * No option skips that.
 *
 * Refuses before asking: TargetNotDisposableError; UnknownMigrationError when
 * the repo has no finalized migration `to`. WipeFailedError (rolled back)
 * when the managed schema holds something it cannot drop.
 */
export async function rebuild(
  project: Project,
  options: RebuildOptions,
): Promise<RebuildResult> {
  const { root, paths, config } = project;
  return runGuarded<readonly MigrationToApply[], RebuildResult>(project, {
    command: "rebuild",
    target: options.target,
    async check(view) {
      const target = view.target.name;
      if (!view.disposable) {
        throw new TargetNotDisposableError("rebuild", target);
      }
      const migrations = await verifiedMigrations(root, paths);
      if (!migrations.some((migration) => migration.number === options.to)) {
        throw new UnknownMigrationError(options.to, migrations.at(-1)?.number);
      }
      const replayed = migrations.filter(
        (migration) => migration.number <= options.to,
      );
      // Each migration's newest variant, as a deployment to a new target.
      const variants = (await readMigrationsWithUnits(root, replayed)).map(
        newestVariant,
      );
      const range =
        options.to === 1 ? "migration 1" : `migrations 1-${options.to}`;
      const wiped = [
        `everything in schema ${config.managedSchema}`,
        "the recorded migrations",
        ...(view.draft === undefined
          ? []
          : [`deployed draft ${view.draft.name}`]),
      ];
      return {
        action: `Wipe target ${target} and replay ${range}`,
        details: [
          `Drops ${wiped.join(", ")}, then deploys in one transaction:`,
          ...replayed.map((migration) => `  ${migration.folder}`),
          "Seed data is never loaded",
        ],
        plan: replayed.map((migration, index) => ({
          number: migration.number,
          name: migration.name,
          contentHash: migration.contentHash,
          chainHash: migration.chainHash,
          ...(variants[index] ?? {
            recovery: undefined,
            unit: { label: migration.folder, files: [] },
          }),
        })),
      };
    },
    async run({ target, session, attempt }, plan) {
      await attempt.setRange(plan);
      const applyOptions = {
        managedSchema: config.managedSchema,
        historySchema: config.historySchema,
        target,
        attemptId: attempt.id,
      };
      await inDeployTransaction(session, applyOptions, async () => {
        await wipeManagedSchema(session, target, config.managedSchema);
        await session.query(
          `DELETE FROM ${historyTable(config.historySchema, "migrations")}`,
        );
        await session.query(
          `DELETE FROM ${historyTable(config.historySchema, "deployed_draft")}`,
        );
        await runMigrations(session, plan, applyOptions);
      });
      return {
        target: target.name,
        deployed: plan.map(({ number, name }) => ({
          number,
          name,
          folder: migrationFolderName(number, name),
        })),
        attemptId: attempt.id,
      };
    },
  });
}
