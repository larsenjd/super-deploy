// The comparison every rehearsal ends with: two databases' managed schemas
// must have the same structure, by the differ (an empty diff) and by our own
// pg_catalog comparison.

import type { Session } from "../adapters/types.ts";
import { differ } from "../differ/index.ts";
import { SuperDeployError } from "../errors.ts";
import { catalogDifferences } from "../verification/catalog.ts";

/** The differ's name without its npm scope, e.g. `pg-delta`, to label its lines. */
const differLabel = differ.name.replace(/^@[^/]+\//, "");

/**
 * Throws RehearsalMismatchError, opening with `subject` (or the draft
 * rehearsal's default), listing the differ's statements that would turn
 * `actual` into `expected` and then the catalog comparison's lines.
 */
export async function requireSameStructure(
  actual: Session,
  expected: Session,
  managedSchema: string,
  subject?: string,
): Promise<void> {
  const differences = [
    ...(await differ.diff(actual, expected)).map(
      (statement) => `${differLabel}: ${statement.sql}`,
    ),
    ...(await catalogDifferences(actual, expected, managedSchema)).map(
      (line) => `catalog: ${line}`,
    ),
  ];
  if (differences.length > 0) {
    throw new RehearsalMismatchError(
      differences,
      subject === undefined ? {} : { subject },
    );
  }
}

/**
 * Replaying the migrations and the draft did not produce the desired schema
 * (or, in a deployment rehearsal, the pending migrations did not produce the
 * newest migration's desired-schema snapshot).
 * Each difference is one line, prefixed with the check that found it:
 * `pg-delta: <statement still needed>` or `catalog: - <line only in the
 * rehearsal>` / `catalog: + <line only in the desired schema>`.
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
