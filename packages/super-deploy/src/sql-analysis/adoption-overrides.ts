// Override markers for adoption (`init --adopt`): which generated
// desired-schema statements only an override marker stands between and
// adoption, and writing the markers into the generated files once a person
// has given a reason for each.
import { isOverridable, markerPrefix, overrideObject } from "./overrides.ts";
import { parseSqlFile, type SqlFile } from "./parse.ts";
import type { RuleContext } from "./rule-types.ts";
import { analyseFile } from "./rules.ts";

/** Something `init --adopt` can only write with an override marker. */
export interface OverrideNeeded {
  /** What it is, e.g. `function load_staging(text)`. */
  readonly object: string;
  /** The risk rules it breaks, sorted, e.g. `plpgsql-dynamic-sql`. */
  readonly rules: readonly string[];
  /** Each rule's refusal, in the rules' words (without the override hint), in file order. */
  readonly findings: readonly {
    readonly rule: string;
    readonly message: string;
  }[];
  /** The desired-schema file the marker goes in (its path as given). */
  readonly file: string;
}

/** A statement whose every rule violation an override marker would accept. */
export interface OverrideCandidate extends OverrideNeeded {
  /** 1-based line of the statement's first token: the marker goes above it. */
  readonly line: number;
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
      if (own.length > 0 && own.every(({ rule }) => isOverridable(rule))) {
        const findings = new Map(
          own.map(({ rule, message }) => [
            `${rule}\0${message}`,
            { rule, message },
          ]),
        );
        candidates.push({
          file: file.path,
          line: statement.line,
          object: overrideObject(statement, context.managedSchema),
          rules: [...new Set(own.map(({ rule }) => rule))].sort(),
          findings: [...findings.values()],
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
