// Rules: an allowlist per file kind (ADR-0002). Anything not explicitly
// allowed is refused, so unfamiliar or newer syntax never slips through.
//
// The desired-schema rules live in desired-schema-rules.ts (ticket 08). The
// deploy-time kinds (schema change, pre- and post-migration scripts, seed
// data) are checked by deploy-time.ts (ticket 06), which also analyses a
// migration's files together (analyseMigration).
import { SuperDeployError } from "../errors.ts";
import {
  analyseMigration,
  type DeployTimeKind,
  type DeployTimeOptions,
} from "./deploy-time.ts";
import { desiredSchemaFindings } from "./desired-schema-rules.ts";
import {
  checkMarkedStatements,
  type Override,
  violationOf,
} from "./overrides.ts";
import { parseSqlFile, type SqlFile } from "./parse.ts";

import type { RuleContext, SchemaReference } from "./rule-types.ts";

export type {
  RuleContext,
  RuleFinding,
  SchemaReference,
} from "./rule-types.ts";

export type FileKind = "desired-schema" | DeployTimeKind;

const defaultContext: RuleContext = {
  managedSchema: "public",
  externalSchemas: [],
};

export interface FileAnalysis {
  /** Every rule violation, in file order. */
  readonly violations: readonly RuleViolation[];
  /** The override markers that were accepted, in file order. */
  readonly overrides: readonly Override[];
}

/**
 * Every rule violation in one file of the given kind, in file order, with
 * override markers applied. `identityColumns` matters for deploy-time kinds
 * only.
 */
export async function checkRules(
  file: SqlFile,
  kind: FileKind,
  context: Partial<RuleContext> & DeployTimeOptions = {},
): Promise<RuleViolation[]> {
  return [...(await analyseFile(file, kind, context)).violations];
}

/** Like `checkRules`, also returning the overrides accepted. */
export async function analyseFile(
  file: SqlFile,
  kind: FileKind,
  context: Partial<RuleContext> & DeployTimeOptions = {},
): Promise<FileAnalysis> {
  if (kind !== "desired-schema") {
    return analyseMigration([{ ...file, kind }], context);
  }
  const parsed = await parseSqlFile(file);
  if (!parsed.ok) {
    return { violations: [parsed.violation], overrides: [] };
  }
  const resolved: RuleContext = {
    managedSchema: context.managedSchema ?? defaultContext.managedSchema,
    externalSchemas: context.externalSchemas ?? defaultContext.externalSchemas,
  };
  return checkMarkedStatements(
    file,
    parsed.statements,
    resolved.managedSchema,
    (statement) =>
      desiredSchemaFindings(statement, resolved).map((finding) =>
        violationOf(statement, finding),
      ),
  );
}

export interface RuleViolation {
  /** Project-relative path with forward slashes. */
  file: string;
  /**
   * 1-based line of the offending part where the parser locates it (e.g. an
   * unnamed constraint), else where the statement (or syntax error) starts.
   */
  line: number;
  /** The offending statement's text (empty for syntax errors). */
  statement: string;
  /** Stable rule identifier, e.g. `desired-schema-statement`. */
  rule: string;
  message: string;
  /**
   * What to do about it, when the rule offers a way: an unmarked risk-rule
   * violation's says how to write the override marker.
   */
  hint?: string;
  /** For `undeclared-schema`: the schema referenced, and where. */
  reference?: SchemaReference;
}

/** One violation as one line: `<file>:<line>: <message>[. <hint>] [<rule>]`. */
export function describeViolation(violation: RuleViolation): string {
  const hint = violation.hint === undefined ? "" : `. ${violation.hint}`;
  return `${violation.file}:${violation.line}: ${violation.message}${hint} [${violation.rule}]`;
}

/**
 * The message names the first violation and counts the rest; `violations`
 * holds them all, and the CLI prints each on a line of its own.
 */
export class SqlRuleViolationError extends SuperDeployError {
  readonly code = "sql-rule-violation";
  readonly violations: readonly RuleViolation[];

  constructor(violations: readonly RuleViolation[]) {
    const [first] = violations;
    const where = first ? describeViolation(first) : "";
    const more =
      violations.length > 1 ? ` (and ${violations.length - 1} more)` : "";
    super(`${where}${more}`);
    this.violations = violations;
  }
}
