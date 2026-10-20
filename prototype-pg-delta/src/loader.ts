// THROWAWAY spike (issue 01). Acceptance criterion 4 / Q35: does pg-delta's
// directory loader (`schema apply --dir` == planSchemaFiles) order desired-schema
// files by dependency on PG18, including FK cycles closed by ALTER TABLE?
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSqlFiles, planSchemaFiles, type SqlFile } from "@supabase/pg-delta";
import { rawProfile } from "@supabase/pg-delta/integrations";
import { analyzeForShadow } from "@supabase/pg-delta/sql-order";
import { analyzeAndSort } from "@supabase/pg-topo";
import type pg from "pg";
import { catalogDifferences } from "./catalog.ts";
import { dropDb, freshDb } from "./pg.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Exactly how pgdelta's CLI reads `--dir`: recursive, readdirSync().sort() per directory. */
export function readDirLikePgDelta(dir: string): SqlFile[] {
  const root = dir;
  const out: SqlFile[] = [];
  const walk = (cur: string) => {
    for (const e of readdirSync(cur).sort()) {
      const full = join(cur, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".sql")) out.push({ name: relative(root, full).split("\\").join("/"), sql: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return out;
}

/** The spec's fallback rule: raw code-point sort of '/'-separated relative paths. */
function codePointCompare(a: string, b: string): number {
  const x = [...a].map((c) => c.codePointAt(0)!);
  const y = [...b].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export function pathOrder(files: SqlFile[]): SqlFile[] {
  return [...files].sort((a, b) => codePointCompare(a.name, b.name));
}

function msg(e: unknown): string {
  if (e && typeof e === "object" && "details" in e && Array.isArray((e as { details: unknown[] }).details)) {
    const d = (e as { details: { code: string; message: string }[] }).details.slice(0, 4).map((x) => `[${x.code}] ${x.message}`);
    return `${(e as Error).message.split("\n")[0]} | ${d.join(" | ")}`.replace(/\s+/g, " ").slice(0, 900);
  }
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 900);
}

export interface LoadAttempt {
  method: string;
  loaded: boolean;
  error?: string;
  warnings: string[];
  extra?: string;
  /** differences vs. the reference (dependency-ordered) load; empty = same desired schema */
  vsReference?: string[];
  pickBinding?: string;
}

async function singlePass(pool: pg.Pool, files: SqlFile[]): Promise<string | undefined> {
  for (const f of files) {
    try {
      await pool.query(f.sql);
    } catch (e) {
      return `${f.name}: ${msg(e)}`;
    }
  }
  return undefined;
}

async function pickBinding(pool: pg.Pool): Promise<string | undefined> {
  try {
    return (await pool.query("select picked from which_pick")).rows[0]?.picked as string;
  } catch {
    return undefined;
  }
}

type Method = (files: SqlFile[], shadow: pg.Pool) => Promise<{ warnings: string[]; extra?: string }>;

const METHODS: Record<string, Method> = {
  "pgdelta schema apply --dir (planSchemaFiles, defaults: lexicographic + retry rounds + statement fallback + pg-topo escalation)":
    async (files, shadow) => {
      const warnings: string[] = [];
      const target = await freshDb("q35_target");
      try {
        const r = await planSchemaFiles(target, shadow, files, { profile: rawProfile, onWarning: (m) => warnings.push(m) });
        const diags = r.loadDiagnostics.map((d) => `${d.code}: ${d.message}`.slice(0, 200));
        return { warnings: [...warnings, ...diags], extra: `plan actions=${r.plan.actions.length}` };
      } finally {
        await dropDb(target);
      }
    },
  "planSchemaFiles with reorder:false (lexicographic + retry rounds + statement fallback only)": async (files, shadow) => {
    const warnings: string[] = [];
    const target = await freshDb("q35_target");
    try {
      await planSchemaFiles(target, shadow, files, { profile: rawProfile, reorder: false, onWarning: (m) => warnings.push(m) });
      return { warnings };
    } finally {
      await dropDb(target);
    }
  },
  "loadSqlFiles whole-file retry only (statementFallback:false, reorderOnFailure:false)": async (files, shadow) => {
    const warnings: string[] = [];
    const r = await loadSqlFiles(files, shadow, { statementFallback: false, reorderOnFailure: false, onWarning: (m) => warnings.push(m) });
    return { warnings, extra: `rounds=${r.rounds}` };
  },
  "pg-topo static order only (analyzeForShadow, one pass, no retries)": async (files, shadow) => {
    const a = await analyzeForShadow(files);
    const diags = a.diagnostics.map((d) => `${d.code}: ${d.message}`.slice(0, 200));
    const err = await singlePass(shadow, a.files);
    if (err) throw new Error(`${err} || pg-topo diagnostics: ${diags.join(" ; ")}`);
    return { warnings: diags, extra: `cycles=${a.cycles.length}, statements=${a.files.length}` };
  },
  "path order, one pass, no retries (spec fallback)": async (files, shadow) => {
    const err = await singlePass(shadow, pathOrder(files));
    if (err) throw new Error(err);
    return { warnings: [] };
  },
};

async function tryLoad(method: string, files: SqlFile[], reference: pg.Pool | undefined): Promise<LoadAttempt> {
  const shadow = await freshDb("q35_shadow");
  const out: LoadAttempt = { method, loaded: false, warnings: [] };
  try {
    const r = await METHODS[method]!(files, shadow);
    out.loaded = true;
    out.warnings = r.warnings;
    out.extra = r.extra;
    if (reference) out.vsReference = await catalogDifferences(reference, shadow);
    out.pickBinding = await pickBinding(shadow);
  } catch (e) {
    out.error = msg(e);
  }
  await dropDb(shadow);
  return out;
}

export interface FixtureResult {
  fixture: string;
  files: string[];
  referenceNote: string;
  attempts: LoadAttempt[];
}

const DEPENDENCY_ORDER = [
  "h_types.sql",
  "i_admins.sql",
  "g_customers.sql",
  "f_orders.sql",
  "e_constraints/customers_last_order_fk.sql",
  "d_functions.sql",
  "c_triggers.sql",
  "b_views.sql",
  "a_policies.sql",
];

async function runFixture(name: string, files: SqlFile[], referenceOrder: string[], referenceNote: string): Promise<FixtureResult> {
  const ref = await freshDb("q35_ref");
  const byName = new Map(files.map((f) => [f.name, f]));
  const err = await singlePass(ref, referenceOrder.map((n) => byName.get(n)!));
  if (err) throw new Error(`reference load for ${name} failed: ${err}`);
  const attempts: LoadAttempt[] = [];
  for (const m of Object.keys(METHODS)) attempts.push(await tryLoad(m, files, ref));
  await dropDb(ref);
  return { fixture: name, files: files.map((f) => f.name), referenceNote, attempts };
}

export interface PgTopoProbe {
  statement: string;
  parsed: boolean;
  diagnostics: string[];
}

/** Does pg-topo (PG17 grammar) parse PG18-only syntax? */
export async function pgTopoPg18Probe(): Promise<PgTopoProbe[]> {
  const stmts = [
    "create table t (a int, b int generated always as (a * 2) virtual);",
    "create table t (a int, b int generated always as (a * 2) stored);",
    "create table t (id int, during tstzrange, primary key (id, during without overlaps));",
    "create table t (a int, constraint c check (a > 0) not enforced);",
    "create table t (a int, constraint a_nn not null a);",
    "update t set a = 1 returning old.a, new.a;",
  ];
  const out: PgTopoProbe[] = [];
  for (const s of stmts) {
    const r = await analyzeAndSort([s]);
    const diags = r.diagnostics.map((d) => `${d.code}: ${d.message}`.slice(0, 160));
    out.push({ statement: s, parsed: r.ordered.length > 0 && !diags.some((d) => d.startsWith("PARSE_ERROR")), diagnostics: diags });
  }
  return out;
}

export async function q35(): Promise<{ fixtures: FixtureResult[]; pgTopo: PgTopoProbe[]; sortExample: Record<string, string[]> }> {
  const shuffled = readDirLikePgDelta(join(FIXTURES, "q35-shuffled"));
  // same files, PG17-parseable (STORED instead of VIRTUAL) so pg-topo can parse everything
  const shuffledPg17 = shuffled.map((f) => ({ ...f, sql: f.sql.replace(") virtual", ") stored") }));
  // same files renamed with numbered prefixes in dependency order (the spec's fallback convention)
  const NUMBERED: Record<string, string> = {
    "h_types.sql": "01-types.sql",
    "i_admins.sql": "02-admins.sql",
    "g_customers.sql": "03-customers.sql",
    "f_orders.sql": "04-orders.sql",
    "e_constraints/customers_last_order_fk.sql": "05-constraints/customers-last-order-fk.sql",
    "d_functions.sql": "06-functions.sql",
    "c_triggers.sql": "07-triggers.sql",
    "b_views.sql": "08-views.sql",
    "a_policies.sql": "09-policies.sql",
  };
  const numbered = pathOrder(shuffled.map((f) => ({ name: NUMBERED[f.name]!, sql: f.sql })));
  const overload = readDirLikePgDelta(join(FIXTURES, "q35-overload-binding"));
  const typo = [...shuffled, { name: "j_typo.sql", sql: "create tabel oops (id int);" }];
  const inlineCycle = [
    { name: "a.sql", sql: "create table a (id int primary key, b_id int references b (id));" },
    { name: "b.sql", sql: "create table b (id int primary key, a_id int references a (id));" },
  ];

  const fixtures: FixtureResult[] = [];
  fixtures.push(await runFixture("q35-shuffled (PG18 syntax: VIRTUAL generated column)", shuffled, DEPENDENCY_ORDER, "reference = files applied in hand-written dependency order"));
  fixtures.push(await runFixture("q35-shuffled, PG17-parseable variant (VIRTUAL -> STORED)", shuffledPg17, DEPENDENCY_ORDER, "reference = files applied in hand-written dependency order"));
  fixtures.push(await runFixture("q35-numbered (same files, numbered prefixes in dependency order)", numbered, numbered.map((f) => f.name), "reference = path order"));
  fixtures.push(await runFixture("q35-overload-binding", overload, ["a_pick_numeric.sql", "c_pick_integer.sql", "b_view.sql"], "reference = all functions first (view binds pick(integer))"));
  fixtures.push(await runFixture("q35-shuffled + a genuine typo (error reporting)", typo, [...DEPENDENCY_ORDER], "reference excludes the typo file"));
  fixtures.push(await runFixture("inline FK cycle with no ALTER TABLE (unsatisfiable, error reporting)", inlineCycle, [], "reference = empty database"));

  // CLI per-directory sort vs. spec's whole-path code-point sort
  const names = ["a-c.sql", "a/b.sql", "B.sql", "a.sql", "a_b/x.sql", "a0.sql"];
  const cliStyle: string[] = [];
  {
    // simulate readdirSync().sort() per directory on a virtual tree
    const tree = new Map<string, string[]>();
    for (const n of names) {
      const [head, ...rest] = n.split("/");
      if (rest.length) tree.set(head!, [...(tree.get(head!) ?? []), rest.join("/")]);
      else tree.set(n, []);
    }
    for (const k of [...tree.keys()].sort()) {
      const kids = tree.get(k)!;
      if (kids.length) for (const c of kids.sort()) cliStyle.push(`${k}/${c}`);
      else cliStyle.push(k);
    }
  }
  const sortExample = {
    "pgdelta CLI (readdirSync().sort() per directory)": cliStyle,
    "spec fallback (code-point sort of whole '/'-joined path)": [...names].sort((a, b) => codePointCompare(a, b)),
  };
  return { fixtures, pgTopo: await pgTopoPg18Probe(), sortExample };
}
