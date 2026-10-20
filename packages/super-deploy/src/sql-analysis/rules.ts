// Rules: an allowlist per file kind (ADR-0002). Anything not explicitly
// allowed is refused, so unfamiliar or newer syntax never slips through.
//
// The desired-schema rules live in desired-schema-rules.ts (ticket 08). The
// deploy-time kinds allow nothing yet, so they fail closed (ticket 06).
import type { RuleViolation } from "../errors.ts";
import {
  desiredSchemaFindings,
  statementName,
} from "./desired-schema-rules.ts";
import { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";
import type { RuleContext, RuleFinding } from "./rule-types.ts";

export type { RuleContext, RuleFinding } from "./rule-types.ts";

export type FileKind =
  | "desired-schema"
  | "schema-change"
  | "pre-migration"
  | "post-migration"
  | "seed-data";

type DeployTimeKind = Exclude<FileKind, "desired-schema">;

const kindNames: Record<DeployTimeKind, string> = {
  "schema-change": "a schema change",
  "pre-migration": "a pre-migration script",
  "post-migration": "a post-migration script",
  "seed-data": "seed data",
};

type Rule = (
  statement: ParsedStatement,
) => { rule: string; message: string } | undefined;

const deployTimeStatements =
  (kind: DeployTimeKind): Rule =>
  (statement) => ({
    rule: "deploy-time-statement",
    message: `${statementName(statement.nodeType)} is not allowed in ${kindNames[kind]}`,
  });

const deployTimeRules: Record<DeployTimeKind, readonly Rule[]> = {
  "schema-change": [deployTimeStatements("schema-change")],
  "pre-migration": [deployTimeStatements("pre-migration")],
  "post-migration": [deployTimeStatements("post-migration")],
  "seed-data": [deployTimeStatements("seed-data")],
};

const defaultContext: RuleContext = {
  managedSchema: "public",
  externalSchemas: [],
};

/** Every rule violation in one file of the given kind, in file order. */
export async function checkRules(
  file: SqlFile,
  kind: FileKind,
  context: Partial<RuleContext> = {},
): Promise<RuleViolation[]> {
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
    const findings: RuleFinding[] =
      kind === "desired-schema"
        ? desiredSchemaFindings(statement, resolved)
        : deployTimeRules[kind].flatMap((rule) => rule(statement) ?? []);
    for (const { line, ...found } of findings) {
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
