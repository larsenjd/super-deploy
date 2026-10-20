// THROWAWAY spike (issue 01). The thin shape super-deploy's `Differ` interface
// would wrap around @supabase/pg-delta: two live databases in, ordered SQL out.
import { createHash } from "node:crypto";
import { diff as rawDiff, plan, type Action, type Plan } from "@supabase/pg-delta";
import { rawProfile, resolveProfile } from "@supabase/pg-delta/integrations";
import type pg from "pg";
import { OWNER } from "./pg.ts";

export interface DiffResult {
  statements: string[];
  sql: string;
  sha256: string;
  plan: Plan;
  /** actions pg-delta says cannot run inside one transaction */
  nonTransactional: Action[];
  extractDiagnostics: string[];
}

function terminate(sql: string): string {
  const t = sql.trimEnd();
  return t.endsWith(";") ? t : `${t};`;
}

/** Diff source -> desired. Mirrors what `schema apply` does at database scope. */
export async function diffDatabases(source: pg.Pool, desired: pg.Pool): Promise<DiffResult> {
  const profile = await resolveProfile(source, rawProfile);
  const s = await profile.extract(source);
  const d = await profile.extract(desired);
  const p = plan(s.factBase, d.factBase, {
    ...profile.planOptions,
    scope: "database",
    defaultOwner: OWNER,
    // database scope drops role facts; roles granted to must be declared as assumed
    assumedRoles: s.factBase
      .facts()
      .filter((f) => f.id.kind === "role")
      .map((f) => (f.id as { name: string }).name),
  });
  const statements = p.actions.map((a) => terminate(a.sql));
  const sql = statements.length === 0 ? "" : `${statements.join("\n\n")}\n`;
  return {
    statements,
    sql,
    sha256: createHash("sha256").update(sql).digest("hex"),
    plan: p,
    nonTransactional: p.actions.filter((a) => a.transactionality !== "transactional"),
    extractDiagnostics: [...s.diagnostics, ...d.diagnostics].map((x) => `${x.code}: ${x.message}`),
  };
}

/** Raw fact-level deltas, unfiltered by scope/profile (a stricter emptiness check). */
export async function rawDeltaCount(a: pg.Pool, b: pg.Pool): Promise<{ count: number; sample: string[] }> {
  const profile = await resolveProfile(a, rawProfile);
  const x = await profile.extract(a);
  const y = await profile.extract(b);
  const deltas = rawDiff(x.factBase, y.factBase);
  return { count: deltas.length, sample: deltas.slice(0, 5).map((d) => JSON.stringify(d).slice(0, 300)) };
}
