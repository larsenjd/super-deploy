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
import { DesiredSchemaLoadError, OrderDependenceError } from "../errors.ts";
import { alternativeOrder } from "../sql-analysis/ordering.ts";
import type { ParsedStatement } from "../sql-analysis/parse.ts";
import { catalogDifferences, catalogSnapshot } from "./catalog-snapshot.ts";
import { loadDesiredSchema, withThrowawayDatabase } from "./throwaway.ts";

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
 * Loads `statements` in another valid order into a second throwaway database
 * (always dropped) and compares its catalog with `loaded`'s. Throws
 * OrderDependenceError naming the objects that differ, or the statement that
 * failed to load.
 */
export async function checkOrderIndependence(
  check: OrderIndependenceCheck,
): Promise<void> {
  const { managedSchema, statements } = check;
  const alternative = alternativeOrder(statements, { managedSchema });
  if (
    alternative.every((statement, index) => statement === statements[index])
  ) {
    return; // The dependencies allow only one order.
  }
  const expected = await catalogSnapshot(check.loaded, managedSchema);
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
      const differences = catalogDifferences(
        expected,
        await catalogSnapshot(session, managedSchema),
      );
      if (differences.length > 0) {
        throw new OrderDependenceError(
          [...new Set(differences.map((d) => d.fact.object))],
          differences.map(
            (d) => `${d.side} ${d.fact.object}: ${d.fact.detail}`,
          ),
        );
      }
    },
  );
}
