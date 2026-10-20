// Deploy-time rules applied to a migration or draft folder, shared by draft,
// rehearse, finalize and validate. The analysis itself is database-free and
// lives in sql-analysis/; this module only gathers its inputs from disk.
import { join, posix } from "node:path";
import { type RuleViolation, SqlRuleViolationError } from "../errors.ts";
import type { ReplayUnit } from "../rehearsal/replay.ts";
import {
  analyseMigration,
  columnTypesOf,
  type DeployTimeFile,
  type IdentityColumns,
  identityColumnsOf,
  type MigrationAnalysis,
  type ParsedStatement,
  parseSqlFile,
  type SqlFile,
} from "../sql-analysis/index.ts";
import { readDesiredSchema } from "../store/desired-schema.ts";
import {
  deployTimeFileKinds,
  type FinalizedMigration,
  snapshotFolderName,
} from "../store/migrations.ts";

export interface MigrationRuleContext {
  readonly managedSchema: string;
  /**
   * The desired schemas on either side of the migration (the previous
   * migration's snapshot and its own, or the current desired schema for the
   * draft): their identity columns are protected from explicit values.
   */
  readonly schemas: readonly DesiredSchema[];
  /**
   * The desired schema before the migration (the previous migration's
   * snapshot): its column types tell a lossy type change from a widening.
   * Without it every type change counts as destructive.
   */
  readonly previous?: DesiredSchema;
}

type DesiredSchema = readonly SqlFile[] | readonly ParsedStatement[];

/** Analyses a migration's or the draft's deploy-time files, in the order they run. */
export async function analyseReplayUnit(
  unit: ReplayUnit,
  context: MigrationRuleContext,
): Promise<MigrationAnalysis> {
  const files: DeployTimeFile[] = unit.files.flatMap(({ file, sql }) => {
    const kind = deployTimeFileKinds[posix.basename(file)];
    return kind === undefined ? [] : [{ path: file, text: sql, kind }];
  });
  return analyseMigration(files, {
    managedSchema: context.managedSchema,
    identityColumns: await identityColumnsIn(context.schemas),
    ...(context.previous === undefined
      ? {}
      : { columnTypes: columnTypesOf(await statementsOf(context.previous)) }),
  });
}

/** Every rule violation in a migration's or the draft's deploy-time files, in the order they run. */
export async function checkReplayUnit(
  unit: ReplayUnit,
  context: MigrationRuleContext,
): Promise<readonly RuleViolation[]> {
  return (await analyseReplayUnit(unit, context)).violations;
}

/**
 * Throws SqlRuleViolationError listing every violation in the unit's files;
 * otherwise returns the analysis (destructive statements and warnings).
 */
export async function refuseRuleViolations(
  unit: ReplayUnit,
  context: MigrationRuleContext,
): Promise<MigrationAnalysis> {
  const analysis = await analyseReplayUnit(unit, context);
  if (analysis.violations.length > 0) {
    throw new SqlRuleViolationError(analysis.violations);
  }
  return analysis;
}

/** The desired-schema snapshot of the newest migration (none before migration 1). */
export async function newestSnapshot(
  root: string,
  migrations: readonly FinalizedMigration[],
): Promise<SqlFile[]> {
  const newest = migrations.at(-1);
  return newest === undefined
    ? []
    : readDesiredSchema(root, join(newest.path, snapshotFolderName));
}

async function identityColumnsIn(
  schemas: MigrationRuleContext["schemas"],
): Promise<IdentityColumns> {
  const merged = new Map<string, Set<string>>();
  for (const schema of schemas) {
    for (const [table, columns] of identityColumnsOf(
      await statementsOf(schema),
    )) {
      merged.set(table, new Set([...(merged.get(table) ?? []), ...columns]));
    }
  }
  return merged;
}

async function statementsOf(schema: DesiredSchema): Promise<ParsedStatement[]> {
  const statements: ParsedStatement[] = [];
  for (const item of schema) {
    if ("nodeType" in item) {
      statements.push(item);
    } else {
      const parsed = await parseSqlFile(item);
      // Syntax errors are reported by the desired-schema rules.
      statements.push(...(parsed.ok ? parsed.statements : []));
    }
  }
  return statements;
}
