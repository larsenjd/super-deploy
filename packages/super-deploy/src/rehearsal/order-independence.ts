// The order-independence check (ADR-0004): load the desired schema a second
// time, in a different valid order, and require the same catalog. A
// difference means the result depends on load order in a way the ordering
// can't see, so the desired schema is refused rather than loaded by luck.
// It samples one other order; it does not prove independence (REFINEMENTS.md).

import type {
  DatabaseRequest,
  RehearsalAdapter,
  Session,
} from "../adapters/types.ts";
import type { ResolvedConfig } from "../config/config.ts";
import { listed, SuperDeployError } from "../errors.ts";
import type { ParsedStatement } from "../sql-analysis/index.ts";
import { alternativeOrder } from "../sql-analysis/index.ts";
import {
  catalogFacts,
  factDifferences,
  factLine,
} from "../verification/catalog.ts";
import {
  DesiredSchemaLoadError,
  draftDatabaseRequest,
  loadDesiredSchema,
  withThrowawayDatabase,
} from "./throwaway.ts";

export interface OrderIndependenceCheck {
  readonly rehearsal: RehearsalAdapter;
  /** Settings for the second throwaway database; use the same as the first. */
  readonly request: DatabaseRequest;
  readonly managedSchema: string;
  /** The ordered statements (from analyseDesiredSchema). */
  readonly statements: readonly ParsedStatement[];
  /** A session on the database `statements` were just loaded into, in that order. */
  readonly loaded: Session;
}

/**
 * Loads the ordered desired schema into `session`, a draft's throwaway
 * database, then checks that another valid order gives the same catalog
 * (checkOrderIndependence).
 */
export async function loadDesiredSchemaCheckingOrder(
  config: ResolvedConfig,
  session: Session,
  statements: readonly ParsedStatement[],
): Promise<void> {
  await loadDesiredSchema(
    session,
    statements,
    config.managedSchema,
    config.externalSchemas,
  );
  await checkOrderIndependence({
    rehearsal: config.rehearsal,
    request: draftDatabaseRequest,
    managedSchema: config.managedSchema,
    statements,
    loaded: session,
  });
}

/**
 * Loads `statements` in another valid order into a second throwaway database
 * (always dropped) and compares its catalog with `loaded`'s. Throws
 * OrderDependenceError naming the objects that differ, or the statement that
 * failed to load.
 */
async function checkOrderIndependence(
  check: OrderIndependenceCheck,
): Promise<void> {
  const { managedSchema, statements } = check;
  const alternative = alternativeOrder(statements, { managedSchema });
  if (
    alternative.every((statement, index) => statement === statements[index])
  ) {
    return; // The dependencies allow only one order.
  }
  const expected = await catalogFacts(check.loaded, managedSchema, {
    bindings: true,
  });
  await withThrowawayDatabase(
    check.rehearsal,
    check.request,
    async (session) => {
      try {
        await loadDesiredSchema(session, alternative, managedSchema);
      } catch (error) {
        if (error instanceof DesiredSchemaLoadError) {
          throw new OrderDependenceError(
            [],
            [],
            { file: error.file, line: error.line, detail: error.detail },
            { cause: error },
          );
        }
        throw error;
      }
      const differences = factDifferences(
        expected,
        await catalogFacts(session, managedSchema, { bindings: true }),
      );
      if (differences.length > 0) {
        throw new OrderDependenceError(
          [...new Set(differences.map((d) => d.fact.object))].sort(),
          differences.map((d) => `${d.side} ${factLine(d.fact)}`),
        );
      }
    },
  );
}

/**
 * The desired schema gives a different catalog, or fails to load, when its
 * statements load in another valid order (the order-independence check).
 */
export class OrderDependenceError extends SuperDeployError {
  readonly code = "order-dependent-desired-schema";
  /** The objects whose catalog entries differ, e.g. `view which_pick`, sorted. */
  readonly objects: readonly string[];
  /**
   * The differing catalog facts, as `- <kind>: <line>` when loaded in the
   * normal order and `+ <kind>: <line>` when loaded in the other order.
   */
  readonly differences: readonly string[];
  /** Set when the other order failed to load instead. */
  readonly failure: { file: string; line: number; detail: string } | undefined;

  constructor(
    objects: readonly string[],
    differences: readonly string[],
    failure?: { file: string; line: number; detail: string },
    options?: ErrorOptions,
  ) {
    super(
      failure === undefined
        ? `The desired schema depends on load order: loaded in another valid order, it gives a different catalog for ${listed(objects)}`
        : `The desired schema depends on load order: it loads in one valid order but not in another, where ${failure.file}:${failure.line} fails: ${failure.detail}. super-deploy may not see a reference this statement makes; please report it`,
      options,
    );
    this.objects = objects;
    this.differences = differences;
    this.failure = failure;
  }
}
