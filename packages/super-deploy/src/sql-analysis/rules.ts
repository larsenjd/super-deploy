// Rules: an allowlist per file kind (ADR-0002). Anything not explicitly
// allowed is refused, so unfamiliar or newer syntax never slips through.
//
// Current coverage: the desired schema accepts CREATE TABLE only (tickets 08
// and 06 widen the desired-schema and deploy-time allowlists). Deploy-time
// kinds allow nothing yet, so they fail closed.
import type { RuleViolation } from "../errors.ts";
import { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";

export type FileKind =
  | "desired-schema"
  | "schema-change"
  | "pre-migration"
  | "post-migration"
  | "seed-data";

const kindNames: Record<FileKind, string> = {
  "desired-schema": "the desired schema",
  "schema-change": "a schema change",
  "pre-migration": "a pre-migration script",
  "post-migration": "a post-migration script",
  "seed-data": "seed data",
};

type Rule = (
  statement: ParsedStatement,
) => { rule: string; message: string } | undefined;

const desiredSchemaStatements: Rule = (statement) =>
  statement.nodeType === "CreateStmt"
    ? undefined
    : {
        rule: "desired-schema-statement",
        message: `${statementName(statement)} is not allowed in the desired schema`,
      };

const deployTimeStatements =
  (kind: FileKind): Rule =>
  (statement) => ({
    rule: "deploy-time-statement",
    message: `${statementName(statement)} is not allowed in ${kindNames[kind]}`,
  });

const rulesByKind: Record<FileKind, readonly Rule[]> = {
  "desired-schema": [desiredSchemaStatements],
  "schema-change": [deployTimeStatements("schema-change")],
  "pre-migration": [deployTimeStatements("pre-migration")],
  "post-migration": [deployTimeStatements("post-migration")],
  "seed-data": [deployTimeStatements("seed-data")],
};

/** Every rule violation in one file of the given kind, in file order. */
export async function checkRules(
  file: SqlFile,
  kind: FileKind,
): Promise<RuleViolation[]> {
  const parsed = await parseSqlFile(file);
  if (!parsed.ok) {
    return [parsed.violation];
  }
  const violations: RuleViolation[] = [];
  for (const statement of parsed.statements) {
    for (const rule of rulesByKind[kind]) {
      const found = rule(statement);
      if (found !== undefined) {
        violations.push({
          file: statement.file,
          line: statement.line,
          statement: statement.text,
          ...found,
        });
      }
    }
  }
  return violations;
}

const names: Record<string, string> = {
  CreateStmt: "CREATE TABLE",
  CreateTableAsStmt: "CREATE TABLE AS / CREATE MATERIALIZED VIEW",
  ViewStmt: "CREATE VIEW",
  IndexStmt: "CREATE INDEX",
  CreateFunctionStmt: "CREATE FUNCTION",
  CreateTrigStmt: "CREATE TRIGGER",
  CreateDomainStmt: "CREATE DOMAIN",
  CompositeTypeStmt: "CREATE TYPE",
  CreateEnumStmt: "CREATE TYPE ... AS ENUM",
  CreateSchemaStmt: "CREATE SCHEMA",
  CreateSeqStmt: "CREATE SEQUENCE",
  CreateExtensionStmt: "CREATE EXTENSION",
  CreatePolicyStmt: "CREATE POLICY",
  AlterTableStmt: "ALTER TABLE",
  DropStmt: "DROP",
  InsertStmt: "INSERT",
  UpdateStmt: "UPDATE",
  DeleteStmt: "DELETE",
  MergeStmt: "MERGE",
  SelectStmt: "SELECT",
  TruncateStmt: "TRUNCATE",
  GrantStmt: "GRANT / REVOKE",
  CommentStmt: "COMMENT",
  TransactionStmt: "Transaction control",
  DoStmt: "DO",
  CallStmt: "CALL",
  VariableSetStmt: "SET",
  CopyStmt: "COPY",
};

function statementName(statement: ParsedStatement): string {
  return names[statement.nodeType] ?? `A ${statement.nodeType} statement`;
}
