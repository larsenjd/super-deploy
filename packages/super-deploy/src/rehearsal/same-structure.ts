// The comparison every rehearsal ends with: two databases' managed schemas
// must have the same structure, by the differ (an empty diff) and by our own
// pg_catalog comparison.

import type { Session } from "../adapters/types.ts";
import { differ, type PlannedStatement } from "../differ/index.ts";
import { SuperDeployError } from "../errors.ts";
import {
  catalogDifferences,
  type FactDifference,
  factLine,
} from "../verification/catalog.ts";

/** The differ's name without its npm scope, e.g. `pg-delta`, to label its lines. */
export const differLabel = differ.name.replace(/^@[^/]+\//, "");

/** The words a catalog line found in only one of the two databases is shown with. */
export interface ComparedSides {
  readonly actual: string;
  readonly expected: string;
}

/** A draft rehearsal's sides: the replay, and the desired schema. */
export const draftSides: ComparedSides = {
  actual: "from the migrations",
  expected: "from the desired schema",
};

/** How two databases' managed schemas differ, by both checks. */
export interface StructuralDifferences {
  /** The differ's statements that would turn `actual` into `expected`. */
  readonly statements: readonly PlannedStatement[];
  /** The catalog comparison's facts found on one side only. */
  readonly catalog: readonly FactDifference[];
}

export interface SameStructureOptions {
  /**
   * Replaces the draft rehearsal's opening of the message; a function gets
   * the differences found (undefined keeps the default).
   */
  readonly subject?:
    | string
    | ((found: StructuralDifferences) => string | undefined);
  /**
   * Replaces `from the migrations` (`actual`, the replay) and `from the
   * desired schema` (`expected`).
   */
  readonly sides?: ComparedSides;
}

/**
 * Throws RehearsalMismatchError, opening with `options.subject` (or the
 * draft rehearsal's default), listing the differ's statements that would
 * turn `actual` into `expected` and then the catalog comparison's lines.
 */
export async function requireSameStructure(
  actual: Session,
  expected: Session,
  managedSchema: string,
  options: SameStructureOptions = {},
): Promise<void> {
  const found = await structuralDifferences(actual, expected, managedSchema);
  const differences = differenceLines(found, options.sides);
  if (differences.length > 0) {
    const subject =
      typeof options.subject === "function"
        ? options.subject(found)
        : options.subject;
    throw new RehearsalMismatchError(
      differences,
      subject === undefined ? {} : { subject },
    );
  }
}

/** Both checks' differences between two databases' managed schemas. */
export async function structuralDifferences(
  actual: Session,
  expected: Session,
  managedSchema: string,
): Promise<StructuralDifferences> {
  return {
    statements: await differ.diff(actual, expected),
    catalog: await catalogDifferences(actual, expected, managedSchema),
  };
}

/** One line per difference, as RehearsalMismatchError lists them. */
export function differenceLines(
  found: StructuralDifferences,
  sides: ComparedSides = draftSides,
): string[] {
  return [
    ...found.statements.map((statement) => `${differLabel}: ${statement.sql}`),
    ...catalogLines(found.catalog, sides),
  ];
}

/** The catalog comparison's lines, as RehearsalMismatchError lists them. */
export function catalogLines(
  catalog: readonly FactDifference[],
  sides: ComparedSides = draftSides,
): string[] {
  return catalog.map(
    ({ side, fact }) => `catalog: ${sides[side]}: ${factLine(fact)}`,
  );
}

/**
 * Replaying the migrations and the draft did not produce the desired schema
 * (or, in a deployment rehearsal, the pending migrations did not produce the
 * newest migration's desired-schema snapshot).
 * Each difference is one line, prefixed with the check that found it:
 * `pg-delta: <statement still needed>`, or `catalog: from the migrations:
 * <line only in the replay>` / `catalog: from the desired schema: <line
 * only in the desired schema>` (a Recovery's rehearsal: `from the Recovery`
 * / `from the original migration`).
 */
export class RehearsalMismatchError extends SuperDeployError {
  readonly code = "rehearsal-mismatch";
  readonly differences: readonly string[];
  /** The message's opening, without the first difference (the CLI lists them all). */
  readonly subject: string;

  /**
   * `subject` replaces the default opening ("The rehearsal does not match
   * the desired schema; run draft again"), e.g. for deployment rehearsals.
   */
  constructor(
    differences: readonly string[],
    options: { subject?: string } = {},
  ) {
    const subject =
      options.subject ??
      "The rehearsal does not match the desired schema; run draft again";
    const [first] = differences;
    const more =
      differences.length > 1 ? ` (and ${differences.length - 1} more)` : "";
    super(`${subject}. First difference: ${first ?? ""}${more}`);
    this.differences = differences;
    this.subject = subject;
  }
}
