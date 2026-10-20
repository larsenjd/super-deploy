// THROWAWAY spike (Q35). Loaders being compared, and a catalog snapshot that
// also records create-time bindings (pg_depend) so order-dependent results show up.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadSqlFiles } from "@supabase/pg-delta";
import type pg from "pg";
import { catalogSnapshot } from "../../prototype-pg-delta/src/catalog.ts";
import type { BuiltinNames, SqlFile, Stmt } from "./analyze.ts";

export function readFixture(dir: string): SqlFile[] {
  const out: SqlFile[] = [];
  const walk = (cur: string) => {
    for (const e of readdirSync(cur).sort()) {
      const full = join(cur, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".sql")) out.push({ name: relative(dir, full).split("\\").join("/"), sql: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

function codePointCompare(a: string, b: string): number {
  const x = [...a].map((c) => c.codePointAt(0)!);
  const y = [...b].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export const pathOrder = (files: SqlFile[]) => [...files].sort((a, b) => codePointCompare(a.name, b.name));

const oneLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 400);

async function inTransaction(pool: pg.Pool, units: { label: string; sql: string }[]): Promise<string | undefined> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local search_path = public, pg_catalog");
    await client.query("set local check_function_bodies = on");
    for (const u of units) {
      try {
        await client.query(u.sql);
      } catch (e) {
        await client.query("rollback").catch(() => {});
        return `${u.label}: ${oneLine(e)}`;
      }
    }
    await client.query("commit");
    return undefined;
  } finally {
    client.release();
  }
}

/** Our loader: statements in the computed order, one transaction, spec 7.4 settings, fail fast. */
export const loadStatements = (pool: pg.Pool, order: Stmt[]) =>
  inTransaction(
    pool,
    order.map((s) => ({ label: `${s.file}:${s.line} (${s.identity})`, sql: s.text })),
  );

/** Spec fallback: whole files in path order, one pass. */
export const loadFiles = (pool: pg.Pool, files: SqlFile[]) => inTransaction(pool, files.map((f) => ({ label: f.name, sql: f.sql })));

/** pg-delta's directory loader (lexicographic + bounded retry rounds + statement fallback; pg-topo not installed). */
export async function loadPgDelta(pool: pg.Pool, files: SqlFile[]): Promise<{ error?: string; rounds?: number; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    const r = await loadSqlFiles(files, pool, { onWarning: (m) => warnings.push(m.replace(/\s+/g, " ").slice(0, 200)) });
    return { rounds: r.rounds, warnings };
  } catch (e) {
    const details = (e as { details?: { message: string }[] }).details ?? [];
    return { error: `${oneLine(e)}${details.length ? ` | ${details.slice(0, 3).map((d) => d.message.replace(/\s+/g, " ").slice(0, 250)).join(" | ")}` : ""}`, warnings };
  }
}

const EXTRA: Record<string, string> = {
  // what each object is bound to (pg_depend) — catches a view/default/policy bound to a different overload
  depends: `
    select pg_describe_object(classid, objid, objsubid) || ' -> ' || pg_describe_object(refclassid, refobjid, refobjsubid) || ' [' || deptype::text || ']'
    from pg_depend
    where objid >= 16384 and deptype in ('n', 'a')
      and pg_describe_object(classid, objid, objsubid) not like '%pg_toast%'
      and pg_describe_object(refclassid, refobjid, refobjsubid) not like '%pg_toast%'`,
  fkIndex: `
    select conrelid::regclass::text || '.' || conname || ' uses index ' || conindid::regclass::text
    from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`,
  // which overload a view actually calls, observed by running it
  viewOutput: `
    select 'which_pick=' || (select picked from which_pick) where to_regclass('public.which_pick') is not null
    union all select 'which_len=' || (select l from which_len) where to_regclass('public.which_len') is not null`,
};

export async function snapshot(pool: pg.Pool): Promise<string[]> {
  const out = await catalogSnapshot(pool);
  for (const [kind, sql] of Object.entries(EXTRA)) {
    try {
      const { rows } = await pool.query({ text: sql, rowMode: "array" });
      for (const r of rows) out.push(`${kind}: ${r[0]}`);
    } catch (e) {
      out.push(`${kind}: ERROR ${oneLine(e)}`);
    }
  }
  return out.sort();
}

export function differences(x: string[], y: string[]): string[] {
  const sx = new Set(x);
  const sy = new Set(y);
  return [...x.filter((l) => !sy.has(l)).map((l) => `- ${l}`), ...y.filter((l) => !sx.has(l)).map((l) => `+ ${l}`)];
}

export async function builtinNames(pool: pg.Pool): Promise<BuiltinNames> {
  const q = async (sql: string) => new Set((await pool.query({ text: sql, rowMode: "array" })).rows.map((r) => r[0] as string));
  return {
    funcs: await q("select distinct proname from pg_proc where pronamespace = 'pg_catalog'::regnamespace"),
    types: await q("select typname from pg_type where typnamespace = 'pg_catalog'::regnamespace"),
    rels: await q("select relname from pg_class where relnamespace = 'pg_catalog'::regnamespace"),
  };
}
