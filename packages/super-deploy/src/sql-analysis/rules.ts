// Rules: an allowlist per file kind (ADR-0002). Anything not explicitly
// allowed is refused, so unfamiliar or newer syntax never slips through.
//
// The desired-schema rules live in desired-schema-rules.ts (ticket 08). The
// deploy-time kinds (schema change, pre- and post-migration scripts, seed
// data) are checked by deploy-time.ts (ticket 06), which also analyses a
// migration's files together (analyseMigration).
import type { RuleViolation } from "../errors.ts";
import {
  analyseMigration,
  type DeployTimeKind,
  type DeployTimeOptions,
} from "./deploy-time.ts";
import { desiredSchemaFindings } from "./desired-schema-rules.ts";
import { parseSqlFile, type SqlFile } from "./parse.ts";
import type { RuleContext } from "./rule-types.ts";

export type { RuleContext, RuleFinding } from "./rule-types.ts";

export type FileKind = "desired-schema" | DeployTimeKind;

const defaultContext: RuleContext = {
  managedSchema: "public",
  externalSchemas: [],
};

/**
 * Every rule violation in one file of the given kind, in file order.
 * `identityColumns` matters for deploy-time kinds only.
 */
export async function checkRules(
  file: SqlFile,
  kind: FileKind,
  context: Partial<RuleContext> & DeployTimeOptions = {},
): Promise<RuleViolation[]> {
  if (kind !== "desired-schema") {
    const analysis = await analyseMigration([{ ...file, kind }], context);
    return [...analysis.violations];
  }
  const parsed = await parseSqlFile(file);
  if (!parsed.ok) {
    return [parsed.violation];
  }
  const resolved: RuleContext = {
    managedSchema: context.managedSchema ?? defaultContext.managedSchema,
    externalSchemas: context.externalSchemas ?? defaultContext.externalSchemas,
  };
  const violations: RuleViolation[] = [];
  for (const statement of parsed.statements) {
    for (const { line, ...found } of desiredSchemaFindings(
      statement,
      resolved,
    )) {
      violations.push({
        file: statement.file,
        line: line ?? statement.line,
        statement: statement.text,
        ...found,
      });
    }
  }
  return violations;
}
