// SQL analysis (database-free): rules and ordering, sharing one splitter.
import { SqlRuleViolationError } from "../errors.ts";
import { orderDesiredSchema } from "./ordering.ts";
import type { ParsedStatement, SqlFile } from "./parse.ts";
import { checkRules, type RuleContext } from "./rules.ts";

export { denylistReason } from "./denylist.ts";
export { isAlreadyInstalled } from "./desired-schema-rules.ts";
export { type OrderingResult, orderDesiredSchema } from "./ordering.ts";
export { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";
export { externalSchemasBoundAtCreate } from "./routine-bodies.ts";
export { checkRules, type FileKind, type RuleContext } from "./rules.ts";

/**
 * Checks every desired-schema file against the rules and orders the
 * statements for loading; throws SqlRuleViolationError listing every problem.
 */
export async function analyseDesiredSchema(
  files: readonly SqlFile[],
  context: Partial<RuleContext> = {},
): Promise<readonly ParsedStatement[]> {
  const violations = [];
  for (const file of files) {
    violations.push(...(await checkRules(file, "desired-schema", context)));
  }
  if (violations.length > 0) {
    throw new SqlRuleViolationError(violations);
  }
  const ordering = await orderDesiredSchema(files);
  if (ordering.errors.length > 0) {
    throw new SqlRuleViolationError(ordering.errors);
  }
  return ordering.statements;
}
