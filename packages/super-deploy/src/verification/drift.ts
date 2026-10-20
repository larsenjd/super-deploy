// Drift: any structural difference between a target's managed schema and a
// replica of what its recorded migrations should have produced (GLOSSARY).
// No exceptions (REFINEMENTS "Tolerating drift"): an object added by hand is
// drift even when a pending migration would create an identical one.
//
// The comparison is our own pg_catalog comparison (verification/catalog.ts),
// which never compares column order and normalises ownership. pg-delta isn't
// used here: it would read the whole target database (history schema and
// all) rather than the managed schema.
import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { targetTimeouts } from "../deploy/target.ts";
import {
  type CatalogFact,
  catalogFacts,
  factDifferences,
  factLine,
} from "./catalog.ts";

/** How an object on the target differs from the replica. */
export type DriftChange =
  /** On the target only: the recorded migrations don't create it. */
  | "extra"
  /** The recorded migrations create it, but the target lacks it. */
  | "missing"
  /** On both, with a different definition. */
  | "changed";

export interface DriftedObject {
  /** The object as PostgreSQL describes it, e.g. `table audit`, `column note of table customers`. */
  readonly object: string;
  readonly change: DriftChange;
  /**
   * The catalog lines that differ: `- <kind>: <line>` only on the target,
   * `+ <kind>: <line>` only on the replica. Lines of parts of an extra or
   * missing object (its columns, constraints) are folded into it.
   */
  readonly differences: readonly string[];
}

/** The drifted objects, sorted by object; empty when the managed schemas match. */
export async function driftBetween(
  target: Session,
  replica: Session,
  managedSchema: string,
  options: DriftOptions = {},
): Promise<DriftedObject[]> {
  return driftedObjects(
    await catalogFacts(target, managedSchema, {
      settings:
        options.target === undefined ? [] : targetTimeouts(options.target),
    }),
    await catalogFacts(replica, managedSchema),
  );
}

export interface DriftOptions {
  /**
   * The target `target` connects to: its catalogs are read under its lock
   * and statement timeouts. Reading a definition (e.g. pg_get_indexdef)
   * waits for a lock on the table, so a table locked ACCESS EXCLUSIVE would
   * otherwise make the drift check hang.
   */
  readonly target?: ResolvedTarget;
}

/** Groups fact differences (target = actual, replica = expected) by object. */
export function driftedObjects(
  target: readonly CatalogFact[],
  replica: readonly CatalogFact[],
): DriftedObject[] {
  const byObject = new Map<string, { sides: Set<string>; lines: string[] }>();
  for (const { side, fact } of factDifferences(target, replica)) {
    const entry = byObject.get(fact.object) ?? { sides: new Set(), lines: [] };
    entry.sides.add(side);
    entry.lines.push(`${side} ${factLine(fact)}`);
    byObject.set(fact.object, entry);
  }
  const onTarget = new Set(target.map((fact) => fact.object));
  const onReplica = new Set(replica.map((fact) => fact.object));
  const objects = [...byObject].map(([object, { lines }]) => ({
    object,
    change: (!onReplica.has(object)
      ? "extra"
      : !onTarget.has(object)
        ? "missing"
        : "changed") as DriftChange,
    differences: lines,
  }));

  // A whole extra or missing table also differs in its columns and
  // constraints ("column a of table t", "constraint c on table t"): report
  // the table once.
  const wholes = new Map(
    objects
      .filter((o) => o.change !== "changed")
      .map((o) => [o.object, o] as const),
  );
  const reported: DriftedObject[] = [];
  const folded = new Map<string, string[]>();
  for (const drifted of objects) {
    const parent =
      drifted.change === "changed"
        ? undefined
        : [...wholes.values()].find(
            (whole) =>
              whole.change === drifted.change &&
              (drifted.object.endsWith(` of ${whole.object}`) ||
                drifted.object.endsWith(` on ${whole.object}`)),
          );
    if (parent === undefined) {
      reported.push(drifted);
    } else {
      const lines = folded.get(parent.object) ?? [];
      lines.push(...drifted.differences);
      folded.set(parent.object, lines);
    }
  }
  return reported
    .map((drifted) => ({
      ...drifted,
      differences: [
        ...drifted.differences,
        ...(folded.get(drifted.object) ?? []),
      ],
    }))
    .sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : 0));
}
