// The V1 Differ: @supabase/pg-delta, pinned to exactly 1.0.0-alpha.59, calling
// extract and plan directly. Never its directory loader, never pg-topo.
// Every pg-delta upgrade re-runs the prototype scenarios (branch prototype/pg-delta).
import { ENGINE_VERSION, type FactBase, plan } from "@supabase/pg-delta";
import { extract } from "@supabase/pg-delta/extract";
import type pg from "pg";
import type { QueryResult, Session } from "../adapters/types.ts";
import type { Differ, PlannedStatement } from "./types.ts";
import { DifferError } from "./types.ts";

export const pgDeltaVersion = "1.0.0-alpha.59";

export const pgDeltaDiffer: Differ = {
  name: "@supabase/pg-delta",
  version: `${pgDeltaVersion} (engine ${ENGINE_VERSION})`,
  async diff(source, desired) {
    let actions: ReturnType<typeof plan>["actions"];
    try {
      const sourceFacts = (await extract(poolOver(source))).factBase;
      const desiredFacts = (await extract(poolOver(desired))).factBase;
      const owner = await source.query<{ owner: string }>(
        "SELECT current_user AS owner",
      );
      actions = plan(sourceFacts, desiredFacts, {
        // Never manage roles; objects belong to whoever deploys them.
        scope: "database",
        defaultOwner: owner.rows[0]?.owner ?? "postgres",
        // Database scope drops role facts, so roles referenced by grants must be declared.
        assumedRoles: [
          ...new Set([...roleNames(sourceFacts), ...roleNames(desiredFacts)]),
        ],
      }).actions;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new DifferError(`pg-delta could not diff the schemas: ${reason}`, {
        cause: error,
      });
    }
    const nonTransactional = actions.filter(
      (action) => action.transactionality !== "transactional",
    );
    if (nonTransactional.length > 0) {
      throw new DifferError(
        `pg-delta generated statements that cannot run in a transaction: ${nonTransactional.map((a) => a.sql).join(" ")}`,
      );
    }
    return actions.map(
      (action): PlannedStatement => ({
        sql: terminate(action.sql),
        destructive: action.dataLoss === "destructive",
        rewritesTable: action.rewriteRisk,
      }),
    );
  },
};

function roleNames(facts: FactBase): string[] {
  return facts
    .facts()
    .filter((fact) => fact.id.kind === "role")
    .map((fact) => (fact.id as { name: string }).name);
}

function terminate(sql: string): string {
  const trimmed = sql.trimEnd();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

/**
 * pg-delta's extract wants a node-postgres Pool. This adapts one Session to
 * the subset it uses (verified against 1.0.0-alpha.59): callback-style
 * connect(), client.query(text[, values]) with simple-protocol batches
 * returning one result per statement, error listeners and release().
 * `max: 1` keeps extraction on this single connection.
 */
function poolOver(session: Session): pg.Pool {
  const query = async (sql: string, values?: unknown[]) => {
    if (values !== undefined) {
      return session.query(sql, values);
    }
    const results: QueryResult[] = await session.execute(sql);
    return results.length === 1 ? results[0] : results;
  };
  const client = { query, on() {}, removeListener() {}, release() {} };
  const pool = {
    options: { max: 1 },
    totalCount: 1,
    idleCount: 0,
    query,
    connect(
      callback: (
        error: Error | undefined,
        c: typeof client,
        release: () => void,
      ) => void,
    ) {
      callback(undefined, client, () => {});
    },
  };
  return pool as unknown as pg.Pool;
}
