// The override marker (spec "Override marker"): `-- OVERRIDE SUPER-DEPLOY
// REFUSAL: <reason>` on the line directly before one statement accepts that
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
import { analyseMigration, type DeployTimeOptions } from "./deploy-time.ts";
import {
  lineAtByte,
  type ParsedStatement,
  parseSqlFile,
  type SqlFile,
} from "./parse.ts";
import { statementFacts } from "./references.ts";
import { ruleCatalogue, ruleDefinition } from "./rule-catalogue.ts";
import type { RuleFinding } from "./rule-types.ts";
import type { RuleViolation } from "./rules.ts";
import { objectTypeName, statementName } from "./statement-names.ts";
import { isObject, statementBody } from "./syntax-tree.ts";

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

export const markerPrefix = "-- OVERRIDE SUPER-DEPLOY REFUSAL:";

const exactForm = `"${markerPrefix} <reason>"`;
/** Ends an unmarked risk-rule violation's message (applyMarker). */
const overrideHint = `If the statement is safe, override the refusal with ${exactForm} on the line before it`;

/**
 * A violation message without applyMarker's override hint, for adoption:
 * it writes the marker itself, after asking for the reason.
 */
export function withoutOverrideHint(message: string): string {
  const hint = `. ${overrideHint}`;
  return message.endsWith(hint) ? message.slice(0, -hint.length) : message;
}
const lookalike = /override\s+super-deploy\s+refusal/i;
/** The marker's form before ticket 24; no longer a marker, but hinted at. */
const oldFormPrefix = "-- OVERRIDE DANGEROUS COMMAND";

export interface Marker {
  readonly line: number;
  readonly reason: string;
}

export interface MarkerScan {
  /** Markers by the index of the statement they apply to. */
  readonly markers: ReadonlyMap<number, Marker>;
  /** Indexes of statements directly preceded by the old marker form. */
  readonly oldForms: ReadonlySet<number>;
  /** Malformed or misplaced markers, in file order. */
  readonly violations: readonly RuleViolation[];
}

/** Finds the override markers in a parsed file. Needs the WASM module loaded (parseSqlFile does that). */
export function scanMarkers(
  file: SqlFile,
  statements: readonly ParsedStatement[],
): MarkerScan {
  const markers = new Map<number, Marker>();
  const oldForms = new Set<number>();
  const violations: RuleViolation[] = [];
  if (!lookalike.test(file.text) && !file.text.includes(oldFormPrefix)) {
    return { markers, oldForms, violations };
  }
  const bytes = Buffer.from(file.text, "utf8");
  const ends = statements.map(
    (statement) => statement.offset + Buffer.byteLength(statement.text),
  );
  /** The statement a comment on its own line directly before it applies to. */
  const markedStatement = (start: number, line: number): number | undefined => {
    const next = statements.findIndex((statement) => statement.offset > start);
    const inside = statements.some(
      (statement, index) =>
        statement.offset <= start && start < (ends[index] ?? 0),
    );
    const lineStart = bytes.lastIndexOf(0x0a, start - 1) + 1;
    const ownLine = /^[ \t]*$/.test(
      bytes.subarray(lineStart, start).toString("utf8"),
    );
    return inside || !ownLine || next < 0 || statements[next]?.line !== line + 1
      ? undefined
      : next;
  };
  const comments = scanSync(file.text).tokens.filter(
    (token) =>
      token.tokenName === "SQL_COMMENT" || token.tokenName === "C_COMMENT",
  );
  for (const comment of comments) {
    const line = lineAtByte(bytes, comment.start);
    if (!lookalike.test(comment.text)) {
      const next = comment.text.startsWith(oldFormPrefix)
        ? markedStatement(comment.start, line)
        : undefined;
      if (next !== undefined) {
        oldForms.add(next);
      }
      continue;
    }
    const violation = (rule: string, message: string): void => {
      violations.push({ file: file.path, line, statement: "", rule, message });
    };
    const match = /^-- OVERRIDE SUPER-DEPLOY REFUSAL:(.*)$/.exec(
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
    const next = markedStatement(comment.start, line);
    if (next === undefined || markers.has(next)) {
      violation(
        "override-misplaced",
        "The override marker must be on its own line, directly before the statement it applies to",
      );
      continue;
    }
    markers.set(next, { line, reason });
  }
  return { markers, oldForms, violations };
}

const overridableRules = ruleCatalogue
  .filter((rule) => rule.overridable)
  .map((rule) => rule.id)
  .join(", ");

/** Whether an override marker accepts a violation of `rule` (a risk rule). */
export function isOverridable(rule: string): boolean {
  return ruleDefinition(rule)?.overridable === true;
}

/** A finding of `statement` as a violation (at the finding's own line, if it has one). */
export function violationOf(
  statement: ParsedStatement,
  { line, ...finding }: RuleFinding,
): RuleViolation {
  return {
    file: statement.file,
    line: line ?? statement.line,
    statement: statement.text,
    ...finding,
  };
}

/**
 * Checks a parsed file's statements in order: each statement's violations
 * (`violationsOf`) go through its override marker (applyMarker), and the
 * markers' own violations land in line order among them.
 */
export function checkMarkedStatements(
  file: SqlFile,
  statements: readonly ParsedStatement[],
  managedSchema: string,
  violationsOf: (statement: ParsedStatement) => RuleViolation[],
): { violations: RuleViolation[]; overrides: Override[] } {
  const scan = scanMarkers(file, statements);
  const violations: RuleViolation[] = [];
  const overrides: Override[] = [];
  const pending = [...scan.violations];
  statements.forEach((statement, index) => {
    while (pending[0] !== undefined && pending[0].line < statement.line) {
      violations.push(pending.shift() as RuleViolation);
    }
    const marked = applyMarker(
      statement,
      index,
      scan,
      violationsOf(statement),
      managedSchema,
    );
    violations.push(...marked.violations);
    if (marked.override !== undefined) {
      overrides.push(marked.override);
    }
  });
  violations.push(...pending);
  return { violations, overrides };
}

/**
 * Applies a statement's marker to the statement's violations: risk-rule
 * violations become an override; every other violation stands. A marker
 * that overrides nothing is itself a violation. Without a marker, risk-rule
 * violations end with a hint: how to write the marker, or, after the old
 * marker form, that the marker is now the new one.
 */
export function applyMarker(
  statement: ParsedStatement,
  index: number,
  scan: MarkerScan,
  violations: readonly RuleViolation[],
  managedSchema: string,
): { violations: RuleViolation[]; override?: Override } {
  const marker = scan.markers.get(index);
  if (marker === undefined) {
    const hint = scan.oldForms.has(index)
      ? `Hint: the override marker is now ${exactForm}`
      : overrideHint;
    return {
      violations: violations.map((violation) =>
        isOverridable(violation.rule)
          ? { ...violation, message: `${violation.message}. ${hint}` }
          : violation,
      ),
    };
  }
  const overridden = violations.filter((violation) =>
    isOverridable(violation.rule),
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
  const body = statementBody(statement);
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
  const relationName = relation(body.relation);
  const name = statementName(statement.nodeType);
  return relationName === undefined ? name : `${name} ${relationName}`;
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
      ).violations.some((violation) => isOverridable(violation.rule));
    carried.push(needed ? `${markerPrefix} ${override.reason}\n${sql}` : sql);
  }
  return carried;
}
