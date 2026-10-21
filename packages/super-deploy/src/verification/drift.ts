// Drift: any structural difference between a target's managed schema and a
// replica of what its recorded migrations should have produced (GLOSSARY).
// No exceptions (REFINEMENTS "Tolerating drift"): an object added by hand is
// drift even when a pending migration would create an identical one.
//
// The comparison is our own pg_catalog comparison (verification/catalog.ts),
// which never compares column order and normalises ownership. pg-delta isn't
// used here: it would read the whole target database (history schema and
// all) rather than the managed schema.
//
// Each difference says in words which side it is on, never a bare `-`/`+`
// (QA 16): `status`, `mark` and the deploy refusal all use `driftLabel` and
// `listedDrift`. Adoption, whose replica is a generated desired schema, words
// its own.

import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { targetTimeouts } from "../deploy/target.ts";
import { listed, SuperDeployError } from "../errors.ts";
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
  /**
   * The object as PostgreSQL describes it, schema-qualified, e.g.
   * `table app.audit`, `column note of table app.customers`.
   */
  readonly object: string;
  readonly change: DriftChange;
  /**
   * The catalog lines that differ, those on the target first. Lines of
   * parts of an extra or missing object (its columns, constraints) are
   * folded into it.
   */
  readonly differences: readonly DriftDifference[];
}

/** One catalog line of a drifted object, and the side it was found on. */
export interface DriftDifference {
  /**
   * `target`: only on the target. `expected`: only on the replica, i.e.
   * expected by the recorded migrations.
   */
  readonly side: "target" | "expected";
  /** `<kind>: <line>`, e.g. `index: CREATE INDEX ...`. */
  readonly line: string;
}

/**
 * The words a drifted object's difference is shown with, by `status`, the
 * deploy refusal and `mark`: one-sided objects are `only on the target` or
 * `missing from the target`; a changed object's lines are `on the target` or
 * `expected by migrations`.
 */
export function driftLabel(
  change: DriftChange,
  side: DriftDifference["side"],
): string {
  if (change !== "changed") {
    return changeWords[change];
  }
  return side === "target" ? "on the target" : "expected by migrations";
}

const changeWords: Readonly<Record<DriftChange, string>> = {
  extra: "only on the target",
  missing: "missing from the target",
  changed: "changed",
};

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
  const byObject = new Map<string, DriftDifference[]>();
  for (const { side, fact } of factDifferences(target, replica)) {
    const lines = byObject.get(fact.object) ?? [];
    lines.push({
      side: side === "actual" ? "target" : "expected",
      line: factLine(fact),
    });
    byObject.set(fact.object, lines);
  }
  const onTarget = new Set(target.map((fact) => fact.object));
  const onReplica = new Set(replica.map((fact) => fact.object));
  const objects = [...byObject].map(([object, lines]) => ({
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
  const folded = new Map<string, DriftDifference[]>();
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

/**
 * Up to five drifted objects with their change in words, e.g.
 * `table app.t (changed)`, `index app.i (only on the target)`.
 */
export function listedDrift(objects: readonly DriftedObject[]): string {
  return listed(objects.map((o) => `${o.object} (${changeWords[o.change]})`));
}

/** What a {@link DriftError}'s message depends on besides the drift. */
export interface DriftContext {
  /** The command that found the drift: `status` doesn't point to itself. */
  readonly command: "deploy" | "status";
  /** How many migrations are pending on the target. */
  readonly pending: number;
}

/**
 * The target's managed schema differs from what its recorded migrations
 * produce on a replica (column order and ownership aside). Deployments
 * refuse until the target matches again; `status` lists the objects.
 *
 * With migrations pending, the message points to `mark`: drift is often a
 * change made on the target by hand that the next pending migration catches
 * up with. Whether it is exactly that migration isn't checked here (it would
 * take a second replica); `mark` checks it.
 */
export class DriftError extends SuperDeployError {
  readonly code = "target-drifted";
  readonly target: string;
  /** Sorted by object; never empty. */
  readonly objects: readonly DriftedObject[];

  constructor(
    target: string,
    objects: readonly DriftedObject[],
    context: DriftContext,
  ) {
    const differences =
      context.command === "status"
        ? ""
        : ` (status --target ${target} lists the differences)`;
    const mark =
      context.pending === 0
        ? ""
        : `. If its changes are those of the next pending migration applied by hand, mark --target ${target} records that migration as deployed`;
    super(
      `Target ${target} has drifted from its recorded migrations: ${listedDrift(objects)}. Deployments refuse until it matches them again${differences}${mark}`,
    );
    this.target = target;
    this.objects = objects;
  }
}
