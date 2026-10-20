// `deploy-draft --target X [--with-seed]`: tries the current, unfinalized
// draft on a disposable target, so its scripts meet realistic data before
// the draft is finalized. A guarded command (guard/guard.ts): terminal-only,
// YES typed exactly, a manual attempt, the target lock.
//
// The draft runs like a pending migration (pre-migration script, schema
// change, post-migration script, in one transaction with the pinned settings
// and the target's timeouts), after its seed data only with `withSeed`. It is
// not rehearsed first: the target is disposable and the transaction rolls
// back on any failure.
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
import { preflightChecks, refusesDeployment } from "../deploy/preflight.ts";
import {
  NoDraftError,
  PreflightFailedError,
  TargetBehindError,
  TargetNotDisposableError,
} from "../errors.ts";
import { runGuarded } from "../guard/guard.ts";
import type { Project } from "../project.ts";
import type { ReplayUnit } from "../rehearsal/replay.ts";
import { runUnit } from "../rehearsal/replay.ts";
import {
  readSeededUnit,
  type SeededUnit,
  seededFiles,
} from "../rehearsal/seed-data.ts";
import { analyseDesiredSchema } from "../sql-analysis/index.ts";
import { asSqlFiles, readDesiredSchemaFiles } from "../store/desired-schema.ts";
import { readDraft } from "../store/draft.ts";
import { sha256 } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { migrationFolderName } from "../store/migrations.ts";
import { newestSnapshot, refuseRuleViolations } from "./check-rules.ts";

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
  /** The recorded migration the draft went on top of (e.g. `00001-add-customers`); undefined when there was none. */
  readonly baseMigration: string | undefined;
  /** Whether seed data was loaded (false when the draft has none). */
  readonly seedData: boolean;
  /** The manual attempt that deployed it. */
  readonly attemptId: number;
}

interface Plan {
  readonly name: string;
  /** The units to run, in order: the seed data (if loaded), then the draft. */
  readonly units: readonly ReplayUnit[];
  readonly seedData: boolean;
  readonly baseMigration: number | undefined;
  readonly baseFolder: string | undefined;
}

/**
 * Terminal-only: shows the target's details at this process's terminal and
 * goes ahead only when the person there types YES. Refuses with
 * TerminalRequiredError in CI or without a terminal on stdin and stdout
 * (before touching the target), and NotConfirmedError for any other answer.
 * No option skips that.
 *
 * Refuses before asking: TargetNotDisposableError; NoDraftError;
 * SqlRuleViolationError for the draft's files; PreflightFailedError when a
 * role or external schema is missing, the recorded history doesn't match the
 * repo, or the target already holds a draft; TargetBehindError when it has
 * pending migrations.
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
      const target = view.target.name;
      if (!view.disposable) {
        throw new TargetNotDisposableError("deploy-draft", target);
      }
      const metadata = await readDraft(paths);
      if (metadata === undefined) {
        throw new NoDraftError("deploy");
      }
      const migrations = await verifiedMigrations(root, paths);
      const seeded = await readSeededUnit(
        root,
        paths.draft,
        `draft ${metadata.name}`,
      );
      await refuseDraftRuleViolations(project, migrations, seeded);
      const units = [
        ...(withSeed && seeded.seedData !== undefined ? [seeded.seedData] : []),
        seeded.migration,
      ];

      const findings = await preflightChecks(session, project, {
        targetName: target,
        migrations,
        recorded: view.recorded,
        pending: units,
      });
      if (refusesDeployment(findings)) {
        throw new PreflightFailedError(target, findings);
      }
      const pending = pendingMigrations(migrations, view.recorded);
      if (pending.length > 0) {
        throw new TargetBehindError(
          target,
          pending.map((migration) => migration.folder),
        );
      }

      const last = view.recorded.at(-1);
      const base =
        last === undefined
          ? undefined
          : migrationFolderName(last.number, last.name);
      const files = units.flatMap((unit) => unit.files.map((f) => f.file));
      return {
        action: `Deploy draft ${metadata.name} to target ${target}`,
        details: [
          `Runs in one transaction, on top of ${base ?? "no recorded migration"}:`,
          ...files.map((file) => `  ${file}`),
          seedDataLine(withSeed, seeded),
          `The target then holds the draft, not a migration: deploy refuses it until rebuild resets it`,
        ],
        plan: {
          name: metadata.name,
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
        baseMigration: plan.baseFolder,
        seedData: plan.seedData,
        attemptId: attempt.id,
      };
    },
  });
}

/** The draft's files must pass the same deploy-time rules as at rehearse. */
async function refuseDraftRuleViolations(
  project: Project,
  migrations: Awaited<ReturnType<typeof verifiedMigrations>>,
  seeded: SeededUnit,
): Promise<void> {
  const { root, paths, config } = project;
  const desiredSchema = await readDesiredSchemaFiles(root, paths.desiredSchema);
  const statements = await analyseDesiredSchema(
    asSqlFiles(root, paths.desiredSchema, desiredSchema),
    {
      managedSchema: config.managedSchema,
      externalSchemas: config.externalSchemas,
    },
  );
  const previous = await newestSnapshot(root, migrations);
  await refuseRuleViolations(seededFiles(seeded), {
    managedSchema: config.managedSchema,
    externalSchemas: config.externalSchemas,
    schemas: [previous, statements],
    previous,
  });
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
