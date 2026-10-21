// `deploy-draft --target X [--with-seed]`: tries the current, unfinalized
// draft on a disposable target, so its scripts meet realistic data before
// the draft is finalized. A guarded command (guard/guard.ts): terminal-only,
// YES typed exactly, a manual attempt, the target lock.
//
// The draft runs like a pending migration (pre-migration script, schema
// change, post-migration script, in one transaction with the pinned settings
// and the target's timeouts), after its seed data only with `withSeed`. It is
// not rehearsed first: the target is disposable and the transaction rolls
// back on any failure. An ordinary draft goes on top of the newest finalized
// migration; a Recovery draft of migration N goes on top of N-1, since it
// runs N's schema change between its scripts. An ordinary draft must have
// been generated from the desired schema now on disk (the hash comparison
// validate warns on), so what is tried is the current work; a Recovery
// draft, like its rehearsal, ignores the desired schema.
//
// What the target records: the draft is not a finalized migration, so no
// migrations row is written. Instead the history schema's `deployed_draft`
// row (written inside the same transaction) says which draft the target
// holds, on top of which recorded migration, with or without seed data. From
// then on the target's structure is no longer that of its recorded
// migrations: deploy (and status, and later mark) treat the deployed draft as
// a history mismatch that refuses deployment, drift is not checked against
// the recorded migrations, and deploy-draft itself refuses a second draft.
// Only `rebuild` resets the target and deletes that row.

import {
  ensureManagedSchemaInTransaction,
  inDeployTransaction,
} from "../deploy/engine.ts";
import { recordDeployedDraft } from "../deploy/history.ts";
import { pendingMigrations } from "../deploy/pending.ts";
import {
  PreflightFailedError,
  preflightChecks,
  refusesDeployment,
} from "../deploy/preflight.ts";
import { requireDisposable } from "../deploy/target.ts";
import { SuperDeployError } from "../errors.ts";
import { runGuarded } from "../guard/guard.ts";
import type { Project } from "../project.ts";
import type { ReplayUnit } from "../rehearsal/replay.ts";
import { runUnit } from "../rehearsal/replay.ts";
import type { SeededUnit } from "../rehearsal/seed-data.ts";
import { type DraftMetadata, NoDraftError, readDraft } from "../store/draft.ts";
import { desiredSchemaHash, sha256 } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import {
  type FinalizedMigration,
  migrationFolderName,
} from "../store/migrations.ts";
import {
  type CheckedDraft,
  checkDraft,
  checkRecoveryDraft,
} from "./rehearse.ts";

export interface DeployDraftOptions {
  /** The target's name in config. */
  target: string;
  /** Load the draft's seed data (seed-data.sql) first. Default false. */
  withSeed?: boolean | undefined;
}

export interface DeployDraftResult {
  readonly target: string;
  /** The draft's name. */
  readonly name: string;
  /** For a Recovery draft: the folder of the migration it recovers (e.g. `00002-require-email`). */
  readonly recoveryOf: string | undefined;
  /** The recorded migration the draft went on top of (e.g. `00001-add-customers`); undefined when there was none. */
  readonly baseMigration: string | undefined;
  /** Whether seed data was loaded (false when the draft has none). */
  readonly seedData: boolean;
  /** The manual attempt that deployed it. */
  readonly attemptId: number;
}

interface Plan {
  readonly name: string;
  readonly recoveryOf: string | undefined;
  /** The units to run, in order: the seed data (if loaded), then the draft. */
  readonly units: readonly ReplayUnit[];
  readonly seedData: boolean;
  readonly baseMigration: number | undefined;
  readonly baseFolder: string | undefined;
}

/**
 * Terminal-only: shows the target's details at this process's terminal,
 * with the pre-flight's warnings (e.g. objects the draft recreates that lose
 * grants made by hand), and goes ahead only when the person there types YES. Refuses with
 * TerminalRequiredError in CI or without a terminal on stdin and stdout
 * (before touching the target), and NotConfirmedError for any other answer.
 * No option skips that.
 *
 * Refuses before asking: TargetNotDisposableError; NoDraftError;
 * SqlRuleViolationError for the draft's files; UndraftedChangesError when
 * the desired schema changed since the draft was generated; PreflightFailedError when a
 * role or external schema is missing, the deploy role doesn't own the
 * managed schema or something in it, the recorded history doesn't match the
 * repo, or the target already holds a draft; TargetBehindError when it has
 * pending migrations. A Recovery draft of migration N goes on top of N-1
 * instead (RecoveryBaseMismatchError otherwise), after the checks rehearse
 * makes (UnknownMigrationError, RecoverySchemaChangeEditedError).
 */
export async function deployDraft(
  project: Project,
  options: DeployDraftOptions,
): Promise<DeployDraftResult> {
  const { root, paths, config } = project;
  const withSeed = options.withSeed === true;
  return runGuarded<Plan, DeployDraftResult>(project, {
    command: "deploy-draft",
    target: options.target,
    async check(view, session) {
      requireDisposable("deploy-draft", view);
      const target = view.target.name;
      const metadata = await readDraft(root, paths);
      if (metadata === undefined) {
        throw new NoDraftError("deploy");
      }
      const migrations = await verifiedMigrations(root, paths);
      const { seeded, migration: recovered } =
        metadata.recoveryOf === undefined
          ? {
              ...(await checkCurrentDraft(project, metadata, migrations)),
              migration: undefined,
            }
          : await checkRecoveryDraft(project, metadata, migrations);
      const units = [
        ...(withSeed && seeded.seedData !== undefined ? [seeded.seedData] : []),
        seeded.migration,
      ];

      const findings = await preflightChecks(session, project, {
        targetName: target,
        migrations,
        recorded: view.recorded,
        pending: units.map((unit) => ({ unit })),
      });
      if (refusesDeployment(findings)) {
        throw new PreflightFailedError(target, findings);
      }
      const last = view.recorded.at(-1);
      const base =
        last === undefined
          ? undefined
          : migrationFolderName(last.number, last.name);
      if (recovered !== undefined) {
        // A Recovery of N runs N's schema change: the target must be at N-1.
        const baseNumber = recovered.number - 1;
        if ((last?.number ?? 0) !== baseNumber) {
          throw new RecoveryBaseMismatchError(
            target,
            recovered.folder,
            migrations[baseNumber - 1]?.folder,
            base,
            baseNumber,
          );
        }
      } else {
        const pending = pendingMigrations(migrations, view.recorded);
        if (pending.length > 0) {
          throw new TargetBehindError(
            target,
            pending.map((migration) => migration.folder),
          );
        }
      }

      const files = units.flatMap((unit) => unit.files.map((f) => f.file));
      const what =
        recovered === undefined
          ? `draft ${metadata.name}`
          : `the Recovery draft of migration ${recovered.folder}`;
      return {
        action: `Deploy ${what} to target ${target}`,
        details: [
          `Runs in one transaction, on top of ${base ?? "no recorded migration"}:`,
          ...files.map((file) => `  ${file}`),
          seedDataLine(withSeed, seeded),
          `The target then holds the draft, not a migration: deploy refuses it until rebuild resets it`,
          ...findings.warnings.map((warning) => `Warning: ${warning}`),
        ],
        plan: {
          name: metadata.name,
          recoveryOf: recovered?.folder,
          units,
          seedData: units.length > 1,
          baseMigration: last?.number,
          baseFolder: base,
        },
      };
    },
    async run({ target, session, attempt }, plan) {
      await inDeployTransaction(
        session,
        {
          managedSchema: config.managedSchema,
          historySchema: config.historySchema,
          target,
          attemptId: attempt.id,
        },
        async () => {
          await ensureManagedSchemaInTransaction(session, config.managedSchema);
          for (const unit of plan.units) {
            await runUnit(session, unit);
          }
          await recordDeployedDraft(session, config.historySchema, {
            name: plan.name,
            contentHash: draftContentHash(plan.units),
            baseMigration: plan.baseMigration,
            seedData: plan.seedData,
            attemptId: attempt.id,
          });
        },
      );
      return {
        target: target.name,
        name: plan.name,
        recoveryOf: plan.recoveryOf,
        baseMigration: plan.baseFolder,
        seedData: plan.seedData,
        attemptId: attempt.id,
      };
    },
  });
}

/** checkDraft, then refuses a draft generated from another desired schema. */
async function checkCurrentDraft(
  project: Project,
  metadata: DraftMetadata,
  migrations: readonly FinalizedMigration[],
): Promise<CheckedDraft> {
  const checked = await checkDraft(project, metadata, migrations);
  if (metadata.desiredSchemaHash !== desiredSchemaHash(checked.desiredSchema)) {
    throw new UndraftedChangesError(metadata.name);
  }
  return checked;
}

function seedDataLine(withSeed: boolean, seeded: SeededUnit): string {
  if (!withSeed) {
    return "Seed data: not loaded";
  }
  return seeded.seedData === undefined
    ? "Seed data: none (the draft has no seed-data.sql)"
    : "Seed data: loaded first";
}

/** sha256 over the files a deploy-draft ran, names and contents, in order. */
export function draftContentHash(units: readonly ReplayUnit[]): string {
  return sha256(
    JSON.stringify(
      units.flatMap((unit) => unit.files.map((file) => [file.file, file.sql])),
    ),
  );
}

/**
 * deploy-draft was refused because the desired schema changed since the
 * draft was generated: the draft would not be the current work. Nothing was
 * asked or changed.
 */
export class UndraftedChangesError extends SuperDeployError {
  readonly code = "undrafted-changes";
  /** The draft's name. */
  readonly draft: string;

  constructor(draft: string) {
    super(
      `The desired schema has changed since draft ${draft} was generated: run draft again`,
    );
    this.draft = draft;
  }
}

/**
 * deploy-draft was refused because the target has pending migrations: the
 * draft's schema change was generated on top of the newest migration, so
 * the target must be there first. Nothing was asked or changed.
 */
export class TargetBehindError extends SuperDeployError {
  readonly code = "target-behind";
  readonly target: string;
  /** The pending migrations' folder names, in order. */
  readonly pending: readonly string[];

  constructor(target: string, pending: readonly string[]) {
    super(
      `Target ${target} has pending migrations (${pending.join(", ")}): deploy them first, because the draft goes on top of the newest migration`,
    );
    this.target = target;
    this.pending = pending;
  }
}

/**
 * deploy-draft of a Recovery draft of migration N needs a target whose last
 * recorded migration is N-1: the Recovery runs N's schema change.
 */
export class RecoveryBaseMismatchError extends SuperDeployError {
  readonly code = "recovery-base-mismatch";
  readonly target: string;
  /** The recovered migration's folder name. */
  readonly migration: string;
  /** The folder of migration N-1; undefined when N is 1. */
  readonly base: string | undefined;
  /** The target's last recorded migration's folder; undefined when none is recorded. */
  readonly recorded: string | undefined;

  constructor(
    target: string,
    migration: string,
    base: string | undefined,
    recorded: string | undefined,
    baseNumber: number,
  ) {
    super(
      `The Recovery draft of migration ${migration} runs on top of ${base ?? "no recorded migration"}, but target ${target} is at ${recorded ?? "no recorded migration"}: run rebuild --to ${baseNumber} first`,
    );
    this.target = target;
    this.migration = migration;
    this.base = base;
    this.recorded = recorded;
  }
}
