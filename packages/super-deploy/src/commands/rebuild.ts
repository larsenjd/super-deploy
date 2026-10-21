// `rebuild --target X --to N`: resets a disposable target to a known
// migration. A guarded command (guard/guard.ts): terminal-only, YES typed
// exactly, a manual attempt, the target lock.
//
// One deploy transaction on the target (pinned settings, the target's
// timeouts): drop everything in the managed schema (deploy/wipe.ts; the
// schema itself, its grants and default privileges stay), delete the
// recorded migrations and any deployed draft from the history schema, then
// run migrations 1 to N exactly as a deployment does, recording each as
// deployed by this attempt (each as its newest variant, like a deployment to
// a new target). Seed data is never loaded. The attempt log and
// the disposable flag are kept. Not rehearsed first: the target is
// disposable and the transaction rolls back on any failure.
//
// The wipe's CASCADE also drops objects in other schemas that depend on
// managed ones. The confirmation lists them ("Also drops, outside schema
// ..."), and the deploy transaction reads them again before wiping: a list
// that changed while the prompt waited refuses with TargetChangedError.
// Before asking, rebuild refuses a managed schema holding something the
// deploy role can't drop (CannotWipeError), so that never surfaces after YES.
//
// The confirmation also lists what in the managed schema no recorded
// migration created (QA 68): drift's objects "only on the target", from a
// replica of the target's recorded migrations as `status` builds it (so a
// deployed draft's objects are listed too), at most 10 and then "and N
// more". It is the repo's migrations of those numbers that are replayed, so
// a recorded migration whose content differs from the repo's is compared as
// the repo has it; a target recording a migration the repo lacks gets a line
// saying why nothing is listed instead, and is still rebuilt. Unlike the
// dependents outside, this list isn't read again under the lock: an object
// appearing meanwhile is in the managed schema, which the box already says
// is dropped entirely, and reading it again would mean another replica.

import type { Session } from "../adapters/types.ts";
import {
  inDeployTransaction,
  type MigrationToApply,
  runMigrations,
} from "../deploy/engine.ts";
import { historyTable } from "../deploy/history.ts";
import { requireDisposable, targetDatabaseRequest } from "../deploy/target.ts";
import {
  dependentsOutside,
  requireWipeable,
  wipeManagedSchema,
} from "../deploy/wipe.ts";
import {
  runGuarded,
  TargetChangedError,
  type TargetView,
} from "../guard/guard.ts";
import type { Project } from "../project.ts";
import {
  type MigrationWithUnit,
  newestVariant,
  readMigrationsWithUnits,
  replicaUnits,
  UnknownRecordedMigrationError,
  withReplica,
} from "../rehearsal/replica.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import {
  migrationFolderName,
  UnknownMigrationError,
} from "../store/migrations.ts";
import { driftBetween } from "../verification/drift.ts";
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

/** What rebuild showed before YES and does after it. */
interface RebuildPlan {
  readonly migrations: readonly MigrationToApply[];
  /** What the wipe drops outside the managed and history schemas, as listed. */
  readonly dependents: readonly string[];
}

/**
 * Terminal-only: shows the target's details at this process's terminal and
 * goes ahead only when the person there types YES. Refuses with
 * TerminalRequiredError in CI or without a terminal on stdin and stdout
 * (before touching the target), and NotConfirmedError for any other answer.
 * No option skips that.
 *
 * Refuses before asking: TargetNotDisposableError; UnknownMigrationError when
 * the repo has no finalized migration `to`; CannotWipeError when the managed
 * schema holds something the deploy role can't drop. After YES, rolled back:
 * TargetChangedError when what it drops outside the managed schema changed
 * meanwhile; WipeDropFailedError when PostgreSQL refuses a drop all the same;
 * WipeFailedError when the managed schema still holds something after the
 * drops.
 */
export async function rebuild(
  project: Project,
  options: RebuildOptions,
): Promise<RebuildResult> {
  const { root, paths, config } = project;
  return runGuarded<RebuildPlan, RebuildResult>(project, {
    command: "rebuild",
    target: options.target,
    async check(view, session) {
      requireDisposable("rebuild", view);
      const target = view.target.name;
      const migrations = await verifiedMigrations(root, paths);
      if (!migrations.some((migration) => migration.number === options.to)) {
        throw new UnknownMigrationError(options.to, migrations.at(-1)?.number);
      }
      const replayed = migrations.filter(
        (migration) => migration.number <= options.to,
      );
      const withUnits = await readMigrationsWithUnits(root, migrations);
      // Each migration's newest variant, as a deployment to a new target.
      const variants = withUnits
        .filter((migration) => migration.number <= options.to)
        .map(newestVariant);
      const range =
        options.to === 1 ? "migration 1" : `migrations 1-${options.to}`;
      const wiped = [
        `everything in schema ${config.managedSchema}`,
        "the recorded migrations",
        ...(view.draft === undefined
          ? []
          : [`deployed draft ${view.draft.name}`]),
      ];
      await requireWipeable(session, target, config.managedSchema);
      const dependents = await dependentsOutside(
        session,
        config.managedSchema,
        config.historySchema,
      );
      return {
        action: `Wipe target ${target} and replay ${range}`,
        details: [
          `Drops ${wiped.join(", ")}, then deploys in one transaction:`,
          ...replayed.map((migration) => `  ${migration.folder}`),
          "Seed data is never loaded",
          ...(await notFromMigrations(project, view, session, withUnits)),
          ...(dependents.length === 0
            ? []
            : [
                "",
                `Also drops, outside schema ${config.managedSchema}:`,
                ...dependents.map((dependent) => `  ${dependent}`),
              ]),
        ],
        plan: {
          migrations: replayed.map((migration, index) => ({
            number: migration.number,
            name: migration.name,
            contentHash: migration.contentHash,
            chainHash: migration.chainHash,
            ...(variants[index] ?? {
              recovery: undefined,
              unit: { label: migration.folder, files: [] },
            }),
          })),
          dependents,
        },
      };
    },
    async run({ target, session, attempt }, { migrations, dependents }) {
      await attempt.setRange(migrations);
      const applyOptions = {
        managedSchema: config.managedSchema,
        historySchema: config.historySchema,
        target,
        attemptId: attempt.id,
      };
      await inDeployTransaction(session, applyOptions, async () => {
        const dropping = await dependentsOutside(
          session,
          config.managedSchema,
          config.historySchema,
        );
        if (dropping.join("\n") !== dependents.join("\n")) {
          throw new TargetChangedError(
            "rebuild",
            target.name,
            `what it drops outside schema ${config.managedSchema}`,
          );
        }
        await wipeManagedSchema(session, target, config.managedSchema);
        await session.query(
          `DELETE FROM ${historyTable(config.historySchema, "migrations")}`,
        );
        await session.query(
          `DELETE FROM ${historyTable(config.historySchema, "deployed_draft")}`,
        );
        await runMigrations(session, migrations, applyOptions);
      });
      return {
        target: target.name,
        deployed: migrations.map(({ number, name }) => ({
          number,
          name,
          folder: migrationFolderName(number, name),
        })),
        attemptId: attempt.id,
      };
    },
  });
}

const shownExtras = 10;

/**
 * The confirmation's lines on what in the managed schema no recorded
 * migration created, after a blank line; none when there is nothing.
 */
async function notFromMigrations(
  project: Project,
  view: TargetView,
  session: Session,
  migrations: readonly MigrationWithUnit[],
): Promise<string[]> {
  const schema = project.config.managedSchema;
  let units: ReturnType<typeof replicaUnits>;
  try {
    units = replicaUnits(view.target.name, migrations, view.recorded);
  } catch (error) {
    if (!(error instanceof UnknownRecordedMigrationError)) {
      throw error;
    }
    return [
      "",
      `Can't tell what no recorded migration created: the repo lacks migration${error.numbers.length === 1 ? "" : "s"} ${error.numbers.join(", ")}`,
    ];
  }
  const drifted = await withReplica(
    project,
    await targetDatabaseRequest(session),
    units,
    (replica) =>
      driftBetween(session, replica, schema, { target: view.target }),
  );
  const extras = drifted
    .filter((drift) => drift.change === "extra")
    .map((drift) => drift.object);
  if (extras.length === 0) {
    return [];
  }
  return [
    "",
    `Not from any recorded migration, in schema ${schema}:`,
    ...extras.slice(0, shownExtras).map((object) => `  ${object}`),
    ...(extras.length > shownExtras
      ? [`  and ${extras.length - shownExtras} more`]
      : []),
  ];
}
