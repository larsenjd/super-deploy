// `draft`: generate the draft's schema change from the newest migration to
// the desired schema. The desired schema is loaded into one throwaway
// database and read back from the catalogs (ADR-0003); the starting point is
// built in another (the finalized migrations replayed, then the draft's seed
// data and pre-migration script); the differ compares the two.
import { posix } from "node:path";
import { differ, type PlannedStatement } from "../differ/index.ts";
import { DraftNameRequiredError, RecoveryDraftError } from "../errors.ts";
import { throwIfInterrupted } from "../interruption.ts";
import type { Project } from "../project.ts";
import { loadDesiredSchemaCheckingOrder } from "../rehearsal/order-independence.ts";
import {
  readMigrationUnits,
  readReplayUnit,
  replay,
} from "../rehearsal/replay.ts";
import {
  type ScriptCoverage,
  scriptCoverage,
} from "../rehearsal/script-coverage.ts";
import {
  readSeededUnit,
  seededFiles,
  seededUnits,
} from "../rehearsal/seed-data.ts";
import {
  draftDatabaseRequest,
  ensureManagedSchema,
  withThrowawayDatabase,
} from "../rehearsal/throwaway.ts";
import {
  carryOverrides,
  desiredSchemaAnalysis,
  type Override,
} from "../sql-analysis/index.ts";
import { asSqlFiles, readDesiredSchemaFiles } from "../store/desired-schema.ts";
import { readDraft, writeDraft } from "../store/draft.ts";
import { normaliseDraftName } from "../store/draft-name.ts";
import { desiredSchemaHash } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import {
  preMigrationFileName,
  schemaChangeFileName,
} from "../store/migrations.ts";
import {
  type MigrationRuleContext,
  newestSnapshot,
  refuseRuleViolations,
} from "./check-rules.ts";

export interface DraftOptions {
  /**
   * The draft's name, normalised to kebab-case. Required when there is no
   * draft yet; for an existing draft, a different name renames it.
   */
  name?: string;
}

export interface DraftResult {
  /** The draft's (normalised) name. */
  readonly name: string;
  /** True if this call created the draft, false if it regenerated an existing one. */
  readonly created: boolean;
  /** The previous name, if this call renamed the draft. */
  readonly renamedFrom: string | undefined;
  /** Absolute path of the generated schema change. */
  readonly schemaChangePath: string;
  /** The generated statements, in order. */
  readonly statements: readonly PlannedStatement[];
  /**
   * What the scripts still need to cover: generated statements that lose or
   * reject existing data (e.g. a dropped column on a table with data), with
   * the affected rows in the rehearsal data. Advisory; empty when none.
   */
  readonly toCover: readonly ScriptCoverage[];
}

export async function draft(
  project: Project,
  options: DraftOptions = {},
): Promise<DraftResult> {
  const requested =
    options.name === undefined ? undefined : normaliseDraftName(options.name);
  const existing = await readDraft(project.root, project.paths);
  if (existing?.recoveryOf !== undefined) {
    throw new RecoveryDraftError(existing.recoveryOf);
  }
  const name = requested ?? existing?.name;
  if (name === undefined) {
    throw new DraftNameRequiredError();
  }

  const { config, paths } = project;
  const files = await readDesiredSchemaFiles(project.root, paths.desiredSchema);
  const { statements, overrides } = await desiredSchemaAnalysis(
    asSqlFiles(project.root, paths.desiredSchema, files),
    {
      managedSchema: config.managedSchema,
      externalSchemas: config.externalSchemas,
    },
  );
  const finalized = await verifiedMigrations(project.root, paths);
  const migrations = await readMigrationUnits(project.root, finalized);
  const rules: MigrationRuleContext = {
    managedSchema: config.managedSchema,
    externalSchemas: config.externalSchemas,
    schemas: [await newestSnapshot(project.root, finalized), statements],
  };
  // The draft's seed data and hand-written scripts are checked before
  // anything runs them; the schema change is regenerated below and checked
  // once written.
  const seeded = await readSeededUnit(project.root, paths.draft, name);
  const handWritten = seededFiles(seeded);
  await refuseRuleViolations(
    {
      ...handWritten,
      files: handWritten.files.filter(
        ({ file }) => posix.basename(file) !== schemaChangeFileName,
      ),
    },
    rules,
  );
  // What runs before the schema change on the diff's starting point: the
  // draft's seed data, then its pre-migration script.
  const beforeSchemaChange = seededUnits({
    ...seeded,
    migration: {
      ...seeded.migration,
      files: seeded.migration.files.filter(
        ({ file }) => posix.basename(file) === preMigrationFileName,
      ),
    },
  });

  const { planned, toCover } = await withThrowawayDatabase(
    config.rehearsal,
    draftDatabaseRequest,
    async (desired) => {
      await loadDesiredSchemaCheckingOrder(config, desired, statements);
      return withThrowawayDatabase(
        config.rehearsal,
        draftDatabaseRequest,
        async (source) => {
          // The starting point: every finalized migration, then the draft's
          // seed data and pre-migration script, in one transaction as a
          // deployment runs them. Renames and backfills done there are not
          // regenerated, and what to cover counts the seeded rows.
          await ensureManagedSchema(source, config.managedSchema);
          await replay(
            source,
            [...migrations, ...beforeSchemaChange],
            config.managedSchema,
          );
          const statements = await differ.diff(source, desired);
          return {
            planned: statements,
            toCover: await scriptCoverage(
              source,
              statements,
              config.managedSchema,
            ),
          };
        },
      );
    },
  );

  throwIfInterrupted(project.signal);
  await writeDraft(
    paths,
    { name, desiredSchemaHash: desiredSchemaHash(files) },
    await renderSchemaChange(planned, overrides, rules),
  );
  // Generated SQL obeys the same rules as hand-written SQL, so a differ bug
  // cannot bypass them. The schema change stays on disk for review.
  await refuseRuleViolations(
    await readReplayUnit(project.root, paths.draft, name),
    rules,
  );
  return {
    name,
    created: existing === undefined,
    renamedFrom:
      existing !== undefined && existing.name !== name
        ? existing.name
        : undefined,
    schemaChangePath: paths.draftSchemaChange,
    statements: planned,
    toCover,
  };
}

/**
 * The schema change file. A statement for an object the desired schema
 * overrides gets the same override marker (by object identity), so the
 * regenerated schema change honours it.
 */
async function renderSchemaChange(
  statements: readonly PlannedStatement[],
  overrides: readonly Override[],
  rules: MigrationRuleContext,
): Promise<string> {
  const header = [
    "-- Schema change generated by super-deploy draft. Do not edit: change the",
    "-- desired schema (or the pre-migration script) and run draft again.",
  ].join("\n");
  const carried = await carryOverrides(
    statements.map((statement) => statement.sql),
    overrides,
    {
      managedSchema: rules.managedSchema,
      externalSchemas: rules.externalSchemas,
    },
  );
  const body = carried.join("\n\n");
  return body === "" ? `${header}\n` : `${header}\n\n${body}\n`;
}
