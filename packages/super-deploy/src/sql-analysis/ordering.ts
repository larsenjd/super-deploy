// Ordering: given the desired-schema files, the statements in the order to
// load them, or errors (unknown references, cycles) with file and line.
//
// PLACEHOLDER until ticket 09 (ADR-0004): files in code-point path order,
// statements in file order. Ticket 09 replaces the body with dependency
// ordering whose result never depends on file names; callers keep this
// signature.
import type { RuleViolation } from "../errors.ts";
import { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";

export interface OrderingResult {
  readonly statements: readonly ParsedStatement[];
  readonly errors: readonly RuleViolation[];
}

export async function orderDesiredSchema(
  files: readonly SqlFile[],
): Promise<OrderingResult> {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const statements: ParsedStatement[] = [];
  const errors: RuleViolation[] = [];
  for (const file of sorted) {
    const parsed = await parseSqlFile(file);
    if (parsed.ok) {
      statements.push(...parsed.statements);
    } else {
      errors.push(parsed.violation);
    }
  }
  return { statements, errors };
}
