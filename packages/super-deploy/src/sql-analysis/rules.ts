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
import {
  checkMarkedStatements,
  type Override,
  violationOf,
} from "./overrides.ts";
import { parseSqlFile, type SqlFile } from "./parse.ts";
import type { RuleContext } from "./rule-types.ts";

export type { RuleContext, RuleFinding } from "./rule-types.ts";

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
