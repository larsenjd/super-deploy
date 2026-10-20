// SQL analysis (database-free): rules and ordering, sharing one splitter.
import { SqlRuleViolationError } from "../errors.ts";
import { orderDesiredSchema } from "./ordering.ts";
import type { ParsedStatement, SqlFile } from "./parse.ts";
import { checkRules } from "./rules.ts";

export { type OrderingResult, orderDesiredSchema } from "./ordering.ts";
export { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";
export { checkRules, type FileKind } from "./rules.ts";

/**
 * Checks every desired-schema file against the rules and orders the
 * statements for loading; throws SqlRuleViolationError listing every problem.
 */
export async function analyseDesiredSchema(
  files: readonly SqlFile[],
): Promise<readonly ParsedStatement[]> {
  const violations = [];
  for (const file of files) {
    violations.push(...(await checkRules(file, "desired-schema")));
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
