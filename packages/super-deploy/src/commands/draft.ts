// `draft`: generate the draft's schema change from the newest migration to
// the desired schema. The desired schema is loaded into one throwaway
// database and read back from the catalogs (ADR-0003); the starting point is
// built in another; the differ compares the two.
import { posix } from "node:path";
import { pgDeltaDiffer } from "../differ/pg-delta.ts";
import type { PlannedStatement } from "../differ/types.ts";
import { DraftNameRequiredError } from "../errors.ts";
import { throwIfInterrupted } from "../interruption.ts";
import type { Project } from "../project.ts";
import { checkOrderIndependence } from "../rehearsal/order-independence.ts";
import {
  readMigrationUnits,
  readReplayUnit,
  replay,
} from "../rehearsal/replay.ts";
import {
  draftDatabaseRequest,
  ensureManagedSchema,
  loadDesiredSchema,
  withThrowawayDatabase,
} from "../rehearsal/throwaway.ts";
import { analyseDesiredSchema } from "../sql-analysis/index.ts";
import { asSqlFiles, readDesiredSchemaFiles } from "../store/desired-schema.ts";
import { readDraft, writeDraft } from "../store/draft.ts";
import { normaliseDraftName } from "../store/draft-name.ts";
import { desiredSchemaHash } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { schemaChangeFileName } from "../store/migrations.ts";
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
}

export async function draft(
  project: Project,
  options: DraftOptions = {},
): Promise<DraftResult> {
  const requested =
    options.name === undefined ? undefined : normaliseDraftName(options.name);
  const existing = await readDraft(project.paths);
  const name = requested ?? existing?.name;
  if (name === undefined) {
    throw new DraftNameRequiredError();
  }

  const { config, paths } = project;
  const files = await readDesiredSchemaFiles(project.root, paths.desiredSchema);
  const statements = await analyseDesiredSchema(
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
    schemas: [await newestSnapshot(project.root, finalized), statements],
  };
  // The draft's hand-written scripts are checked before anything runs them;
  // the schema change is regenerated below and checked once written.
  if (existing !== undefined) {
    const scripts = await readReplayUnit(project.root, paths.draft, name);
    await refuseRuleViolations(
      {
        ...scripts,
        files: scripts.files.filter(
          ({ file }) => posix.basename(file) !== schemaChangeFileName,
        ),
      },
      rules,
    );
  }

  const planned = await withThrowawayDatabase(
    config.rehearsal,
    draftDatabaseRequest,
    async (desired) => {
      await loadDesiredSchema(
        desired,
        statements,
        config.managedSchema,
        config.externalSchemas,
      );
      await checkOrderIndependence({
        rehearsal: config.rehearsal,
        request: draftDatabaseRequest,
        managedSchema: config.managedSchema,
        statements,
        loaded: desired,
      });
      return withThrowawayDatabase(
        config.rehearsal,
        draftDatabaseRequest,
        async (source) => {
          // The starting point: every finalized migration replayed. Ticket 07
          // then runs the draft's pre-migration script.
          await ensureManagedSchema(source, config.managedSchema);
          await replay(source, migrations, config.managedSchema);
          return pgDeltaDiffer.diff(source, desired);
        },
      );
    },
  );

  throwIfInterrupted(project.signal);
  await writeDraft(
    paths,
    { name, desiredSchemaHash: desiredSchemaHash(files) },
    renderSchemaChange(planned),
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
  };
}

function renderSchemaChange(statements: readonly PlannedStatement[]): string {
  const header = [
    "-- Schema change generated by super-deploy draft. Do not edit: change the",
    "-- desired schema (or the pre-migration script) and run draft again.",
  ].join("\n");
  const body = statements.map((statement) => statement.sql).join("\n\n");
  return body === "" ? `${header}\n` : `${header}\n\n${body}\n`;
}
