// Override markers for adoption (`init --adopt`): which generated
// desired-schema statements only an override marker stands between and
// adoption, and writing the markers into the generated files once a person
// has given a reason for each.
import type { RuleViolation } from "../errors.ts";
import { markerPrefix, overrideObject } from "./overrides.ts";
import { parseSqlFile, type SqlFile } from "./parse.ts";
import { ruleDefinition } from "./rule-catalogue.ts";
import type { RuleContext } from "./rule-types.ts";
import { analyseFile } from "./rules.ts";

/** A statement whose every rule violation an override marker would accept. */
export interface OverrideCandidate {
  /** The file's path, as given. */
  readonly file: string;
  /** 1-based line of the statement's first token: the marker goes above it. */
  readonly line: number;
  /** What the statement creates, e.g. `function load_staging(text)`. */
  readonly object: string;
  /** The risk rules it breaks, sorted. */
  readonly rules: readonly string[];
  /** The violations themselves, in file order. */
  readonly violations: readonly RuleViolation[];
}

/**
 * The desired-schema statements, in file order, that break only overridable
 * (risk) rules. Statements that also break any other rule are left out:
 * a marker could not make them acceptable.
 */
export async function overrideCandidates(
  files: readonly SqlFile[],
  context: RuleContext,
): Promise<OverrideCandidate[]> {
  const candidates: OverrideCandidate[] = [];
  for (const file of files) {
    const parsed = await parseSqlFile(file);
    if (!parsed.ok) {
      continue;
    }
    const { violations } = await analyseFile(file, "desired-schema", context);
    for (const statement of parsed.statements) {
      const own = violations.filter(
        (violation) => violation.statement === statement.text,
      );
      if (
        own.length > 0 &&
        own.every(
          (violation) => ruleDefinition(violation.rule)?.overridable === true,
        )
      ) {
        candidates.push({
          file: file.path,
          line: statement.line,
          object: overrideObject(statement, context.managedSchema),
          rules: [...new Set(own.map((violation) => violation.rule))].sort(),
          violations: own,
        });
      }
    }
  }
  return candidates;
}

/**
 * `text` with an override marker on its own line above each given line
 * (1-based, of `text`). A reason is kept to one line.
 */
export function withOverrideMarkers(
  text: string,
  markers: readonly { readonly line: number; readonly reason: string }[],
): string {
  const lines = text.split("\n");
  const byLine = [...markers].sort((a, b) => b.line - a.line);
  for (const { line, reason } of byLine) {
    lines.splice(line - 1, 0, `${markerPrefix} ${oneLine(reason)}`);
  }
  return lines.join("\n");
}

/** A reason as a marker holds it: whitespace runs (newlines too) become one space. */
export function oneLine(reason: string): string {
  return reason.replace(/\s+/g, " ").trim();
}
