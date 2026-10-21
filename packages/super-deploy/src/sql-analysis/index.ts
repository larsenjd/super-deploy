// SQL analysis (database-free): rules and ordering, sharing one splitter.

import { orderDesiredSchema, statementProblems } from "./ordering.ts";
import type { Override } from "./overrides.ts";
import { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";
import {
  type UnqualifiedNameWarning,
  unqualifiedNameWarnings,
} from "./routine-bodies.ts";
import {
  analyseFile,
  type RuleContext,
  type RuleViolation,
  SqlRuleViolationError,
} from "./rules.ts";

export {
  type AdoptedFile,
  type AdoptionOptions,
  adoptedDesiredSchema,
  adoptedObject,
  adoptedObjectReference,
  type CatalogReference,
  type ExternalSchemaReference,
  externalSchemaReferences,
  isSequenceStatement,
} from "./adoption.ts";
export {
  type OverrideCandidate,
  type OverrideNeeded,
  oneLine,
  overrideCandidates,
  withOverrideMarkers,
} from "./adoption-overrides.ts";
export { denylistReason } from "./denylist.ts";
export {
  analyseMigration,
  type DeployTimeFile,
  type DeployTimeKind,
  type DeployTimeOptions,
  type IdentityColumns,
  identityColumnsOf,
  type MigrationAnalysis,
} from "./deploy-time.ts";
export {
  catalogObjectFinding,
  isAlreadyInstalled,
  serialColumnFinding,
  virtualGeneratedColumnFinding,
} from "./desired-schema-rules.ts";
export {
  type ColumnTypes,
  columnTypesOf,
  type DestructiveKind,
  type DestructiveStatement,
  type LockWarning,
  type LockWarningKind,
} from "./destructive.ts";
export {
  alternativeOrder,
  type OrderingOptions,
  type OrderingResult,
  orderDesiredSchema,
} from "./ordering.ts";
export {
  carryOverrides,
  isOverridable,
  type Override,
  overrideObject,
} from "./overrides.ts";
export { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";
export {
  externalSchemasBoundAtCreate,
  type UnqualifiedNameWarning,
} from "./routine-bodies.ts";
export {
  type RuleCategory,
  type RuleDefinition,
  ruleCatalogue,
  ruleDefinition,
} from "./rule-catalogue.ts";
export {
  analyseFile,
  checkRules,
  type FileAnalysis,
  type FileKind,
  type RuleContext,
} from "./rules.ts";

export interface DesiredSchemaAnalysis {
  /** The statements in load order. */
  readonly statements: readonly ParsedStatement[];
  /** The override markers accepted, in file order. */
  readonly overrides: readonly Override[];
  /**
   * Routines whose bodies name the desired schema's objects without a
   * schema, so they fail for callers without the managed schema on their
   * search_path; in file order. Advisory.
   */
  readonly unqualifiedNames: readonly UnqualifiedNameWarning[];
}

/**
 * Checks every desired-schema file against the rules and orders the
 * statements for loading; throws SqlRuleViolationError listing every problem
 * at once. When the rules refuse something, ordering's checks of each
 * statement on its own (unnamed constraints and indexes) are listed with
 * them; its checks across statements (unknown references, duplicates,
 * cycles) wait until the rules pass, since a refused statement may be what
 * another refers to.
 */
export async function analyseDesiredSchema(
  files: readonly SqlFile[],
  context: Partial<RuleContext> = {},
): Promise<readonly ParsedStatement[]> {
  return (await desiredSchemaAnalysis(files, context)).statements;
}

/** Like `analyseDesiredSchema`, also returning the overrides accepted. */
export async function desiredSchemaAnalysis(
  files: readonly SqlFile[],
  context: Partial<RuleContext> = {},
): Promise<DesiredSchemaAnalysis> {
  const violations = [];
  const overrides: Override[] = [];
  for (const file of files) {
    const analysis = await analyseFile(file, "desired-schema", context);
    violations.push(...analysis.violations);
    overrides.push(...analysis.overrides);
  }
  if (violations.length > 0) {
    throw new SqlRuleViolationError(
      await withStatementProblems(files, violations, context),
    );
  }
  const ordering = await orderDesiredSchema(
    files,
    context.managedSchema === undefined
      ? {}
      : { managedSchema: context.managedSchema },
  );
  if (ordering.errors.length > 0) {
    throw new SqlRuleViolationError(ordering.errors);
  }
  const order = new Map(files.map((file, index) => [file.path, index]));
  const unqualifiedNames = unqualifiedNameWarnings(
    ordering.statements,
    context.managedSchema ?? "public",
  ).sort(
    (a, b) =>
      (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0) || a.line - b.line,
  );
  return { statements: ordering.statements, overrides, unqualifiedNames };
}
/**
 * `violations` (the rules', in file order) with ordering's checks of each
 * statement in a file that parses, sorted by file (in `files` order) and
 * line. A statement the rules refused isn't also reported as unorderable.
 */
async function withStatementProblems(
  files: readonly SqlFile[],
  violations: readonly RuleViolation[],
  context: Partial<RuleContext>,
): Promise<RuleViolation[]> {
  const refused = new Set(
    violations.map(({ file, statement }) => `${file}\0${statement}`),
  );
  const all = [...violations];
  for (const file of files) {
    const parsed = await parseSqlFile(file);
    for (const statement of parsed.ok ? parsed.statements : []) {
      const { problems } = statementProblems(
        statement,
        context.managedSchema ?? "public",
      );
      all.push(
        ...problems.filter(
          (problem) =>
            problem.rule !== "unorderable-statement" ||
            !refused.has(`${statement.file}\0${statement.text}`),
        ),
      );
    }
  }
  const order = new Map(files.map((file, index) => [file.path, index]));
  return all
    .map((violation, index) => ({ violation, index }))
    .sort(
      (a, b) =>
        (order.get(a.violation.file) ?? 0) -
          (order.get(b.violation.file) ?? 0) ||
        a.violation.line - b.violation.line ||
        a.index - b.index,
    )
    .map(({ violation }) => violation);
}

export {
  describeViolation,
  type RuleViolation,
  SqlRuleViolationError,
} from "./rules.ts";
