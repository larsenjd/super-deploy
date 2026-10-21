// SQL analysis (database-free): rules and ordering, sharing one splitter.

import { orderDesiredSchema } from "./ordering.ts";
import type { Override } from "./overrides.ts";
import type { ParsedStatement, SqlFile } from "./parse.ts";
import {
  analyseFile,
  type RuleContext,
  SqlRuleViolationError,
} from "./rules.ts";

export {
  type AdoptedFile,
  type AdoptionOptions,
  adoptedDesiredSchema,
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
export { externalSchemasBoundAtCreate } from "./routine-bodies.ts";
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
}

/**
 * Checks every desired-schema file against the rules and orders the
 * statements for loading; throws SqlRuleViolationError listing every problem.
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
    throw new SqlRuleViolationError(violations);
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
  return { statements: ordering.statements, overrides };
}
export {
  describeViolation,
  type RuleViolation,
  SqlRuleViolationError,
} from "./rules.ts";
