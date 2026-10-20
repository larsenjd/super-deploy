// The comparison every rehearsal ends with: two databases' managed schemas
// must have the same structure, by the differ (an empty diff) and by our own
// pg_catalog comparison.
import type { Session } from "../adapters/types.ts";
import { differ } from "../differ/index.ts";
import { RehearsalMismatchError } from "../errors.ts";
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
