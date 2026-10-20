// The override marker (spec "Override marker"): `-- OVERRIDE DANGEROUS
// COMMAND: <reason>` on the line directly before one statement accepts that
// statement's risk-rule violations (dynamic SQL, denylisted calls) and
// records them, so a justified exception is possible but always visible.
// Transaction-breaking rules can never be overridden (rule-catalogue.ts).
//
// PostgreSQL 18's parser leaves leading comments out of statement locations,
// so markers are read from the raw text between statements. libpg-query's
// scanner finds the comments, so text inside strings and dollar-quoted
// bodies never counts.
//
// Overrides are recorded by object identity (what the statement creates or
// changes, e.g. `function load_orders(text)`), so a regenerated schema change
// can carry the desired schema's marker to the statement for that object
// (`carryOverrides`).
import { scanSync } from "libpg-query";
import type { RuleViolation } from "../errors.ts";
import { analyseMigration, type DeployTimeOptions } from "./deploy-time.ts";
import {
  lineAtByte,
  type ParsedStatement,
  parseSqlFile,
  type SqlFile,
} from "./parse.ts";
import { statementFacts } from "./references.ts";
import { ruleCatalogue, ruleDefinition } from "./rule-catalogue.ts";
import { objectTypeName, statementName } from "./statement-names.ts";
import { isObject, unwrap } from "./syntax-tree.ts";

/** One accepted override: a marker and the risk rules it overrode. */
export interface Override {
  /** Project-relative path of the file with the marker. */
  readonly file: string;
  /** 1-based line of the marker. */
  readonly line: number;
  /** What the statement creates or changes, e.g. `function load_orders(text)`. */
  readonly object: string;
  /** The rule ids overridden, sorted. */
  readonly rules: readonly string[];
  readonly reason: string;
}

export const markerPrefix = "-- OVERRIDE DANGEROUS COMMAND:";

const exactForm = `"${markerPrefix} <reason>"`;
const lookalike = /override\s+dangerous\s+command/i;

export interface Marker {
  readonly line: number;
  readonly reason: string;
}

export interface MarkerScan {
  /** Markers by the index of the statement they apply to. */
  readonly markers: ReadonlyMap<number, Marker>;
  /** Malformed or misplaced markers, in file order. */
  readonly violations: readonly RuleViolation[];
}

/** Finds the override markers in a parsed file. Needs the WASM module loaded (parseSqlFile does that). */
export function scanMarkers(
  file: SqlFile,
  statements: readonly ParsedStatement[],
): MarkerScan {
  const markers = new Map<number, Marker>();
  const violations: RuleViolation[] = [];
  if (!lookalike.test(file.text)) {
    return { markers, violations };
  }
  const bytes = Buffer.from(file.text, "utf8");
  const ends = statements.map(
    (statement) => statement.offset + Buffer.byteLength(statement.text),
  );
  const comments = scanSync(file.text).tokens.filter(
    (token) =>
      (token.tokenName === "SQL_COMMENT" || token.tokenName === "C_COMMENT") &&
      lookalike.test(token.text),
  );
  for (const comment of comments) {
    const line = lineAtByte(bytes, comment.start);
    const violation = (rule: string, message: string): void => {
      violations.push({ file: file.path, line, statement: "", rule, message });
    };
    const match = /^-- OVERRIDE DANGEROUS COMMAND:(.*)$/.exec(
      comment.text.replace(/\r$/, ""),
    );
    if (match === null) {
      violation(
        "override-malformed",
        `Malformed override marker: write it exactly as ${exactForm}, on the line before the statement`,
      );
      continue;
    }
    const reason = (match[1] ?? "").trim();
    if (reason === "") {
      violation(
        "override-without-reason",
        `The override marker needs a reason: ${exactForm}`,
      );
      continue;
    }
    const next = statements.findIndex(
      (statement) => statement.offset > comment.start,
    );
    const inside = statements.some(
      (statement, index) =>
        statement.offset <= comment.start && comment.start < (ends[index] ?? 0),
    );
    const lineStart = bytes.lastIndexOf(0x0a, comment.start - 1) + 1;
    const ownLine = /^[ \t]*$/.test(
      bytes.subarray(lineStart, comment.start).toString("utf8"),
    );
    if (
      inside ||
      !ownLine ||
      next < 0 ||
      statements[next]?.line !== line + 1 ||
      markers.has(next)
    ) {
      violation(
        "override-misplaced",
        "The override marker must be on its own line, directly before the statement it applies to",
      );
      continue;
    }
    markers.set(next, { line, reason });
  }
  return { markers, violations };
}

const overridableRules = ruleCatalogue
  .filter((rule) => rule.overridable)
  .map((rule) => rule.id)
  .join(", ");

/**
 * Applies a statement's marker to the statement's violations: risk-rule
 * violations become an override; every other violation stands. A marker
 * that overrides nothing is itself a violation.
 */
export function applyMarker(
  statement: ParsedStatement,
  marker: Marker | undefined,
  violations: readonly RuleViolation[],
  managedSchema: string,
): { violations: RuleViolation[]; override?: Override } {
  if (marker === undefined) {
    return { violations: [...violations] };
  }
  const overridden = violations.filter(
    (violation) => ruleDefinition(violation.rule)?.overridable === true,
  );
  const standing = violations.filter(
    (violation) => !overridden.includes(violation),
  );
  if (overridden.length > 0) {
    return {
      violations: standing,
      override: {
        file: statement.file,
        line: marker.line,
        object: overrideObject(statement, managedSchema),
        rules: [
          ...new Set(overridden.map((violation) => violation.rule)),
        ].sort(),
        reason: marker.reason,
      },
    };
  }
  const refused = [...new Set(standing.map((violation) => violation.rule))];
  return {
    violations: [
      ...standing,
      {
        file: statement.file,
        line: marker.line,
        statement: statement.text,
        rule: "override-unused",
        message:
          refused.length > 0
            ? `The override marker cannot override ${refused.join(", ")}: only risk rules (${overridableRules}) can be overridden`
            : "The override marker overrides nothing: the statement breaks no rule, so remove the marker",
      },
    ],
  };
}

/** The object a statement creates or changes, as recorded in an override. */
export function overrideObject(
  statement: ParsedStatement,
  managedSchema: string,
): string {
  const body = unwrap(statement.node, statement.nodeType) ?? {};
  const relation = (value: unknown) =>
    isObject(value) && typeof value.relname === "string"
      ? value.relname
      : undefined;
  if (statement.nodeType === "AlterTableStmt") {
    const objtype =
      typeof body.objtype === "string" ? body.objtype : "OBJECT_TABLE";
    return `${objectTypeName(objtype)} ${relation(body.relation) ?? "?"}`;
  }
  const identity = statementFacts(statement.node, managedSchema)?.identity;
  if (identity !== undefined && identity !== "") {
    const schema = managedSchema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return identity.replace(new RegExp(`(^|[\\s(,])${schema}\\.`, "g"), "$1");
  }
  const target = relation(body.relation);
  const name = statementName(statement.nodeType);
  return target === undefined ? name : `${name} ${target}`;
}

/**
 * Carries the desired schema's override markers into a regenerated schema
 * change: a generated statement gets the marker of the desired-schema
 * override for the same object, if it breaks an overridable rule itself.
 * `statements` are the generated statements' SQL, one statement each.
 */
export async function carryOverrides(
  statements: readonly string[],
  overrides: readonly Override[],
  options: DeployTimeOptions = {},
): Promise<string[]> {
  if (overrides.length === 0) {
    return [...statements];
  }
  const managedSchema = options.managedSchema ?? "public";
  const carried: string[] = [];
  for (const sql of statements) {
    const file = { path: "schema-change.sql", text: sql };
    const parsed = await parseSqlFile(file);
    const [statement] = parsed.ok ? parsed.statements : [];
    const override =
      statement === undefined
        ? undefined
        : overrides.find(
            ({ object }) => object === overrideObject(statement, managedSchema),
          );
    const needed =
      override !== undefined &&
      (
        await analyseMigration([{ ...file, kind: "schema-change" }], options)
      ).violations.some(
        (violation) => ruleDefinition(violation.rule)?.overridable === true,
      );
    carried.push(needed ? `${markerPrefix} ${override.reason}\n${sql}` : sql);
  }
  return carried;
}
