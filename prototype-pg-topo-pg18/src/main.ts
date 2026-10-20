// THROWAWAY spike: does @supabase/pg-topo support PostgreSQL 18?
// Run from the repo root with: pnpm prototype:pg-topo-pg18
// Starts a private PostgreSQL 18 (embedded-postgres), creates only databases named
// prototype_pg_topo_pg18_wipe_me*, prints a summary and writes prototype-pg-topo-pg18/output/.
//
// Compares two pg-topo variants (src/topo.ts) with the schema-ordering PoC
// (../prototype-schema-ordering/src/analyze.ts, libpg-query@18), on:
//   1. a statement matrix (src/cases.ts): spec §4.1 forms + PG18 syntax
//   2. the PoC and q35 fixtures
//   3. determinism probes: file-path tie-break (renames, locale), unresolved refs, leading comments
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, init, order as pocOrder, type SqlFile, type TieBreak } from "../../prototype-schema-ordering/src/analyze.ts";
import { builtinNames, differences, readFixture, snapshot } from "../../prototype-schema-ordering/src/load.ts";
import { CASES } from "./cases.ts";
import { dropDb, freshDb, PREFIX, startCluster, stopCluster } from "./pg.ts";
import { loadVariants, type TopoResult } from "./topo.ts";

const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  process.stdout.write(`${s}\n`);
};
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const oneLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
const term = (s: string) => (s.trimEnd().endsWith(";") ? s.trim() : `${s.trim()};`);
type Pool = Awaited<ReturnType<typeof freshDb>>;

async function inTx(pool: Pool, stmts: { label: string; sql: string }[]): Promise<string | undefined> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local search_path = public, pg_catalog");
    await c.query("set local check_function_bodies = on");
    for (const s of stmts) {
      try {
        await c.query(s.sql);
      } catch (e) {
        await c.query("rollback").catch(() => {});
        return `${s.label}: ${oneLine(e)}`;
      }
    }
    await c.query("commit");
    return undefined;
  } finally {
    c.release();
  }
}

/** Load statements into a fresh db; return error or catalog snapshot. */
async function loadSnap(stmts: { label: string; sql: string }[]): Promise<{ error?: string; snap?: string[] }> {
  const pool = await freshDb("load");
  try {
    const error = await inTx(pool, stmts);
    return error ? { error } : { snap: await snapshot(pool) };
  } finally {
    await dropDb(pool);
  }
}

const key = (id: { filePath: string; statementIndex: number }) => `${id.filePath}#${id.statementIndex}`;

/** Other valid linear extensions of pg-topo's OWN edge graph (ignores its phase/class/path tie-breaks).
 *  If one fails to load, pg-topo is missing an edge and only its tie-break hid it. */
function altOrders(r: TopoResult): { name: string; order: TopoResult["ordered"] }[] {
  const nodes = r.ordered;
  const pos = new Map(nodes.map((n, i) => [key(n.id), i]));
  const out = new Map<number, number[]>();
  const indeg0 = nodes.map(() => 0);
  for (const e of r.graph.edges as { from: { filePath: string; statementIndex: number }; to: { filePath: string; statementIndex: number } }[]) {
    const f = pos.get(key(e.from));
    const t = pos.get(key(e.to));
    if (f === undefined || t === undefined || f === t) continue;
    out.set(f, [...(out.get(f) ?? []), t]);
    indeg0[t]!++;
  }
  const run = (pick: (ready: number[]) => number) => {
    const indeg = [...indeg0];
    const ready = nodes.map((_, i) => i).filter((i) => indeg[i] === 0);
    const res: number[] = [];
    while (ready.length) {
      const i = pick(ready);
      ready.splice(ready.indexOf(i), 1);
      res.push(i);
      for (const t of out.get(i) ?? []) if (--indeg[t]! === 0) ready.push(t);
    }
    // cycle leftovers: append in pg-topo order (same as pg-topo does: cycles last)
    for (let i = 0; i < nodes.length; i++) if (!res.includes(i)) res.push(i);
    return res.map((i) => nodes[i]!);
  };
  const rng = (seed: number) => {
    let x = seed >>> 0 || 1;
    return () => {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      return x;
    };
  };
  const res = [{ name: "reverse (latest ready first)", order: run((rd) => Math.max(...rd)) }];
  for (const s of [1, 2, 3]) {
    const g = rng(s);
    res.push({ name: `random-valid(seed ${s})`, order: run((rd) => rd[g() % rd.length]!) });
  }
  return res;
}

const diagSummary = (r: TopoResult) => {
  const m = new Map<string, number>();
  for (const d of r.diagnostics) m.set(d.code, (m.get(d.code) ?? 0) + 1);
  return [...m].map(([k, v]) => `${k}x${v}`).join(", ") || "none";
};

const t0 = Date.now();
const server = await startCluster();
log(`PostgreSQL: ${server}\nDatabases: ${PREFIX}*\n`);
await init();
const variants = await loadVariants();
for (const v of variants) log(`pg-topo variant "${v.name}": ${v.parser}${v.loadError ? ` LOAD ERROR ${v.loadError}` : ""}`);
const results: Record<string, unknown> = { server, variants: variants.map((v) => ({ name: v.name, parser: v.parser, loadError: v.loadError })) };
const allUnresolved: { variant: string; where: string; message: string }[] = [];

try {
  const probe = await freshDb("builtins");
  const builtins = await builtinNames(probe);
  await dropDb(probe);

  // ---------------------------------------------------------------- 1. matrix
  log("\n################ 1. Statement matrix (inputs fed REVERSED, one input per statement) ################");
  const matrix: unknown[] = [];
  for (const c of CASES) {
    const stmts = c.stmts.map(term);
    log(`\n== ${c.id} [V1 ${c.v1}${c.pg18 ? ", PG18" : ""}] ${c.title}`);
    const ref = await loadSnap(stmts.map((s, i) => ({ label: `authored#${i}`, sql: s })));
    log(`   reference (authored order): ${ref.error ? `FAILED ${ref.error}` : "loads"}`);
    const row: Record<string, unknown> = { id: c.id, title: c.title, v1: c.v1, pg18: !!c.pg18, reference: ref.error ?? "ok" };
    const reversed = [...stmts].reverse();

    for (const v of variants) {
      if (!v.mod) continue;
      const r = await v.mod.analyzeAndSort(reversed);
      const parseErr = r.diagnostics.filter((d) => d.code === "PARSE_ERROR");
      const dropped = stmts.length - r.ordered.length;
      for (const d of r.diagnostics.filter((d) => d.code === "UNRESOLVED_DEPENDENCY")) allUnresolved.push({ variant: v.name, where: c.id, message: d.message });
      const load = dropped ? { error: `skipped: ${dropped} statement(s) missing from ordered output` } : await loadSnap(r.ordered.map((s) => ({ label: key(s.id), sql: s.sql })));
      const same = load.snap && ref.snap ? differences(ref.snap, load.snap) : undefined;
      const edgeFails: string[] = [];
      if (!dropped) {
        for (const alt of altOrders(r)) {
          const a = await loadSnap(alt.order.map((s) => ({ label: key(s.id), sql: s.sql })));
          if (a.error) edgeFails.push(`${alt.name}: ${a.error}`);
          else if (ref.snap && differences(ref.snap, a.snap!).length) edgeFails.push(`${alt.name}: different catalog`);
        }
      }
      const status = parseErr.length ? "PARSE_ERROR" : load.error ? "LOAD FAILED" : same?.length ? "loads, DIFFERENT catalog" : "OK";
      log(`   [${v.name}] ${status}; ordered ${r.ordered.length}/${stmts.length}; diagnostics: ${diagSummary(r)}`);
      for (const d of parseErr) log(`       PARSE_ERROR ${d.statementId ? key(d.statementId) : ""}: ${oneLine(d.message)}`);
      for (const d of r.diagnostics.filter((d) => d.code !== "PARSE_ERROR")) log(`       ${d.code}: ${oneLine(d.message).slice(0, 200)}`);
      if (load.error && !parseErr.length) log(`       load: ${load.error}`);
      if (!dropped) log(`       edges-only orders (4): ${edgeFails.length ? `${edgeFails.length} FAIL -> missing edge hidden by tie-break: ${edgeFails[0]!.slice(0, 220)}` : "all load the same catalog"}`);
      row[v.name] = { status, ordered: r.ordered.length, of: stmts.length, diagnostics: r.diagnostics.map((d) => `${d.code}: ${oneLine(d.message)}`), load: load.error ?? "ok", edgesOnlyFailures: edgeFails, order: r.ordered.map((s) => s.sql.slice(0, 70)) };
    }

    // PoC for comparison
    const files: SqlFile[] = reversed.map((s, i) => ({ name: `in${String(i).padStart(2, "0")}.sql`, sql: s }));
    const a = analyze(files, builtins);
    const o = pocOrder(a);
    const errs = a.findings.filter((f) => f.level === "error");
    let pocStatus: string;
    const pocGuard: string[] = [];
    if (errs.length || o.cycle) pocStatus = `REFUSED statically: ${errs.map((e) => `${e.code} ${e.message}`).join("; ")}${o.cycle ? " cycle" : ""}`;
    else {
      const l = await loadSnap(o.order.map((s) => ({ label: s.identity, sql: s.text })));
      pocStatus = l.error ? `LOAD FAILED ${l.error}` : ref.snap && differences(ref.snap, l.snap!).length ? "loads, DIFFERENT catalog" : "OK";
      for (const m of ["reverse-ignore-priority", { seed: 1 }, { seed: 2 }, { seed: 3 }] as TieBreak[]) {
        const g = await loadSnap(pocOrder(a, m).order.map((s) => ({ label: s.identity, sql: s.text })));
        if (g.error) pocGuard.push(`${JSON.stringify(m)}: ${g.error}`);
        else if (ref.snap && differences(ref.snap, g.snap!).length) pocGuard.push(`${JSON.stringify(m)}: different catalog`);
      }
    }
    log(`   [PoC libpg-query@18] ${pocStatus}${pocGuard.length ? `; edges-only orders: ${pocGuard.length} FAIL: ${pocGuard[0]!.slice(0, 200)}` : errs.length || o.cycle ? "" : "; edges-only orders: all same"}`);
    row.poc = { status: pocStatus, edgesOnlyFailures: pocGuard };
    matrix.push(row);
  }
  results.matrix = matrix;

  // ---------------------------------------------------------------- 2. fixtures
  log("\n################ 2. Fixtures (PoC + q35), analyzeAndSortFromFiles ################");
  const FIXTURES: [string, string][] = [
    ["q35-shuffled", here("../../prototype-pg-delta/fixtures/q35-shuffled")],
    ["q35-overload-binding", here("../../prototype-pg-delta/fixtures/q35-overload-binding")],
    ...["overloads", "overload-ambiguous", "extraction-gap", "domain-composite", "view-chain", "sql-functions", "triggers-policies", "fk-index-choice", "unnamed-index", "cycle-error", "unresolved"].map(
      (n) => [n, here(`../../prototype-schema-ordering/fixtures/${n}`)] as [string, string],
    ),
  ];
  const fixtureResults: unknown[] = [];
  for (const [name, dir] of FIXTURES) {
    const files = readFixture(dir);
    log(`\n== ${name}: ${files.length} files`);
    const a = analyze(files, builtins);
    const o = pocOrder(a);
    const pocErr = a.findings.filter((f) => f.level === "error");
    let pocSnap: string[] | undefined;
    if (!pocErr.length && !o.cycle) {
      const l = await loadSnap(o.order.map((s) => ({ label: `${s.file}:${s.line}`, sql: s.text })));
      pocSnap = l.snap;
      log(`   [PoC] ${l.error ? `LOAD FAILED ${l.error}` : `loads (${o.order.length} statements)`}`);
    } else log(`   [PoC] refused statically: ${[...pocErr.map((e) => e.code), o.cycle ? "CYCLE" : ""].filter(Boolean).join(", ")}`);
    const fr: Record<string, unknown> = { fixture: name, poc: pocSnap ? "ok" : "refused/failed", pocOrder: o.order.map((s) => s.identity) };

    for (const v of variants) {
      if (!v.mod) continue;
      const r = await v.mod.analyzeAndSortFromFiles([dir]);
      const dropped = a.statements.length - r.ordered.length;
      const parseErr = r.diagnostics.filter((d) => d.code === "PARSE_ERROR");
      for (const d of r.diagnostics.filter((d) => d.code === "UNRESOLVED_DEPENDENCY")) allUnresolved.push({ variant: v.name, where: name, message: d.message });
      const l = await loadSnap(r.ordered.map((s) => ({ label: key(s.id), sql: s.sql })));
      const diff = l.snap && pocSnap ? differences(pocSnap, l.snap) : undefined;
      const status = l.error ? `LOAD FAILED: ${l.error}` : diff === undefined ? "loads (no PoC reference)" : diff.length ? `loads, DIFFERENT catalog from PoC (${diff.length} lines)` : "loads, SAME catalog as PoC";
      log(`   [${v.name}] ordered ${r.ordered.length}/${a.statements.length}${dropped ? ` (${dropped} DROPPED)` : ""}; diagnostics: ${diagSummary(r)}; ${status}`);
      for (const d of parseErr) log(`       PARSE_ERROR ${d.statementId ? key(d.statementId) : ""}: ${oneLine(d.message)}`);
      for (const d of r.diagnostics.filter((d) => ["CYCLE_DETECTED", "DUPLICATE_PRODUCER", "CYCLE_EDGE_SKIPPED"].includes(d.code))) log(`       ${d.code}: ${oneLine(d.message).slice(0, 200)}`);
      for (const d of (diff ?? []).slice(0, 4)) log(`       ${d.slice(0, 200)}`);
      // edges-only orders
      const edgeFails: string[] = [];
      if (!dropped && pocSnap) {
        for (const alt of altOrders(r)) {
          const x = await loadSnap(alt.order.map((s) => ({ label: key(s.id), sql: s.sql })));
          if (x.error) edgeFails.push(`${alt.name}: ${x.error}`);
          else if (differences(pocSnap, x.snap!).length) edgeFails.push(`${alt.name}: different catalog: ${differences(pocSnap, x.snap!).slice(0, 2).join(" | ")}`);
        }
        log(`       edges-only orders (4): ${edgeFails.length ? `${edgeFails.length} differ/fail: ${edgeFails[0]!.slice(0, 240)}` : "all same as PoC"}`);
      }
      // file-name invariance: rename every file so path order reverses
      let renamed = "n/a";
      if (!parseErr.length) {
        const tmp = mkdtempSync(join(tmpdir(), "pgtopo-rename-"));
        const sorted = [...files].sort((x, y) => (x.name < y.name ? -1 : 1));
        sorted.forEach((f, i) => {
          const p = join(tmp, `${String(sorted.length - i).padStart(2, "0")}_${f.name.replaceAll("/", "__")}`);
          writeFileSync(p, f.sql);
        });
        const r2 = await v.mod.analyzeAndSortFromFiles([tmp]);
        const sameOrder = JSON.stringify(r2.ordered.map((s) => s.sql)) === JSON.stringify(r.ordered.map((s) => s.sql));
        const l2 = await loadSnap(r2.ordered.map((s) => ({ label: key(s.id), sql: s.sql })));
        const cat = l.snap && l2.snap ? (differences(l.snap, l2.snap).length ? `DIFFERENT catalog (${differences(l.snap, l2.snap).slice(0, 2).join(" | ").slice(0, 200)})` : "same catalog") : `load: ${l2.error ?? l.error}`;
        renamed = `${sameOrder ? "same statement order" : "ORDER CHANGED"}, ${cat}`;
        rmSync(tmp, { recursive: true, force: true });
        log(`       renamed files (path order reversed): ${renamed}`);
      }
      log(`       order: ${r.ordered.map((s) => `${s.id.filePath}#${s.id.statementIndex}`).join(" | ")}`);
      fr[v.name] = { ordered: r.ordered.length, of: a.statements.length, diagnostics: r.diagnostics.map((d) => `${d.code}: ${oneLine(d.message)}`), status, diff: diff?.slice(0, 20), edgesOnlyFailures: edgeFails, renamed, order: r.ordered.map((s) => key(s.id)) };
    }
    fixtureResults.push(fr);
  }
  results.fixtures = fixtureResults;

  // ---------------------------------------------------------------- 3. determinism probes
  log("\n################ 3. Determinism probes ################");
  // 3a. locale-dependent path tie-break
  const ldir = mkdtempSync(join(tmpdir(), "pgtopo-locale-"));
  writeFileSync(join(ldir, "t.sql"), "create table t (id int primary key, a int);\n");
  writeFileSync(join(ldir, "ä.sql"), "create index on t (a) where a > 0;\n");
  writeFileSync(join(ldir, "z.sql"), "create index on t (a);\n");
  writeFileSync(join(ldir, "B.sql"), "create index on t (id, a);\n");
  writeFileSync(join(ldir, "a.sql"), "create index on t (id, a) where id > 0;\n");
  const localeRuns: unknown[] = [];
  for (const [vi, v] of variants.entries()) {
    if (!v.mod) continue;
    for (const loc of ["en_US.UTF-8", "sv_SE.UTF-8"]) {
      const p = spawnSync(process.execPath, [here("./locale-child.ts"), String(vi), ldir], { env: { ...process.env, LANG: loc, LC_ALL: loc }, encoding: "utf8" });
      if (p.status !== 0) {
        log(`   [${v.name}] LANG=${loc}: child failed ${p.stderr.slice(0, 300)}`);
        continue;
      }
      const res = JSON.parse(p.stdout) as { locale: string; order: { file: string; sql: string }[] };
      const l = await (async () => {
        const pool = await freshDb("locale");
        try {
          const err = await inTx(pool, res.order.map((s) => ({ label: s.file, sql: s.sql })));
          if (err) return err;
          const { rows } = await pool.query("select indexrelid::regclass::text as name, pg_get_expr(indpred, indrelid) as pred, indkey::text as cols from pg_index where indrelid = 't'::regclass and not indisprimary order by 1");
          return rows.map((x) => `${x.name}=(${x.cols})${x.pred ? ` where ${x.pred}` : ""}`).join(", ");
        } finally {
          await dropDb(pool);
        }
      })();
      log(`   [${v.name}] LANG=${loc} (ICU ${res.locale}): file order ${res.order.map((s) => s.file).join(", ")} -> ${l}`);
      localeRuns.push({ variant: v.name, lang: loc, icu: res.locale, order: res.order.map((s) => s.file), indexes: l });
    }
  }
  const cp = ["t.sql", "ä.sql", "z.sql", "B.sql", "a.sql"].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  log(`   code-point order of the same names (spec §3.2 fallback rule): ${cp.join(", ")}`);
  rmSync(ldir, { recursive: true, force: true });
  results.locale = localeRuns;

  // 3b. unresolved references: warn-and-drop?
  log("\n   UNRESOLVED_DEPENDENCY diagnostics seen across sections 1-2 (per variant):");
  for (const v of variants) {
    const u = allUnresolved.filter((x) => x.variant === v.name);
    log(`   [${v.name}] ${u.length} total`);
    for (const x of u) log(`       ${x.where}: ${x.message.slice(0, 160)}`);
  }
  results.unresolved = allUnresolved;

  // 3c. leading comments / annotations / override marker
  log("\n   leading comments (pg-topo annotations and our -- OVERRIDE marker):");
  const ann = [
    "-- header comment of the file",
    "create table ann_t (id int);",
    "",
    "-- pg-topo:phase bootstrap",
    "-- OVERRIDE DANGEROUS COMMAND: needs dynamic SQL",
    "create function ann_fn() returns int language plpgsql as $$ begin execute 'select 1'; return 1; end $$;",
    "-- pg-topo:depends_on public.ann_zzz_missing",
    "create view ann_v as select id from ann_t;",
  ].join("\n");
  const annRuns: unknown[] = [];
  for (const v of variants) {
    if (!v.mod) continue;
    const r = await v.mod.analyzeAndSort([ann]);
    for (const s of r.ordered) {
      const hasMarker = s.sql.includes("OVERRIDE DANGEROUS COMMAND");
      log(`   [${v.name}] #${s.id.statementIndex} phase=${s.phase} sql starts ${JSON.stringify(s.sql.slice(0, 50))}${hasMarker ? " (marker kept in slice)" : ""}`);
    }
    log(`   [${v.name}] diagnostics: ${r.diagnostics.map((d) => `${d.code}: ${oneLine(d.message).slice(0, 120)}`).join(" | ") || "none"}`);
    annRuns.push({ variant: v.name, ordered: r.ordered.map((s) => ({ i: s.id.statementIndex, phase: s.phase, sql: s.sql })), diagnostics: r.diagnostics.map((d) => d.code) });
  }
  results.annotations = annRuns;

  // 3c'. requires extracted for bodies and other expression slots (schema-QUALIFIED, so qualifiedOnly does not apply)
  log("\n   requires extracted per statement (references written schema-qualified):");
  const probes = [
    "create function plq() returns int language plpgsql as $$ declare n int; begin select count(*) into n from public.pt; perform public.helper(1); return n; end $$;",
    "create function sqlq() returns bigint language sql as $$ select count(*) from public.pt $$;",
    "create function sqlq_unqualified() returns bigint language sql as $$ select count(*) from pt $$;",
    "create function f1() returns bigint language sql begin atomic select count(*) from public.v1; end;",
    "create function f2() returns bigint language sql return public.f1() + 1;",
    "create function f3(p numeric default public.base_price()) returns int language sql return 1;",
    "create trigger tr before update on public.doc for each row when (public.changed(old.body, new.body)) execute function public.touch();",
    "create type public.contact as (name text, mail public.work_email);",
    "create table rc2 (id int, src regclass default 'public.rc'::regclass);",
    "create function rc_name(x public.rc.n%type) returns text language sql immutable return x;",
    "create view vv as select c.id, c.order_count from public.cust c;",
    "comment on constraint cm_pk on public.cm is 'pk';",
  ];
  const fmtRef = (r: unknown) => {
    const x = r as { kind: string; schema?: string; name: string; signature?: string };
    return `${x.kind}:${x.schema ? `${x.schema}.` : ""}${x.name}${x.signature ?? ""}`;
  };
  const reqRuns: Record<string, Record<string, string>> = {};
  for (const v of variants) {
    if (!v.mod) continue;
    const r = await v.mod.analyzeAndSort(probes);
    reqRuns[v.name] = {};
    for (const s of r.ordered) reqRuns[v.name]![s.sql.slice(0, 70)] = (s.requires as unknown[]).map(fmtRef).filter((x) => !x.startsWith("type:pg_catalog") && x !== "schema:public").join(", ") || "(nothing)";
  }
  for (const p of probes) {
    log(`   ${p.slice(0, 110)}`);
    for (const v of Object.keys(reqRuns)) log(`       [${v}] requires: ${reqRuns[v]![p.slice(0, 70)] ?? "(statement missing)"}`);
  }
  results.requiresProbes = reqRuns;

  // 3d. pg-delta's consumer API on the stock install: does a PG18 file vanish?
  try {
    const so = (await import("@supabase/pg-delta/sql-order")) as { analyzeForShadow: (f: SqlFile[]) => Promise<{ files: unknown[]; diagnostics: { code: string; message: string }[] }>; orderForShadow: (f: SqlFile[]) => Promise<unknown[]> };
    const files = readFixture(here("../../prototype-pg-delta/fixtures/q35-shuffled"));
    const az = await so.analyzeForShadow(files);
    log(`\n   pg-delta@1.0.0-alpha.59 analyzeForShadow (stock pg-topo) on q35-shuffled: ${az.files.length} single-statement files out; diagnostics: ${az.diagnostics.map((d) => d.code).join(", ") || "none"}`);
    try {
      const of = await so.orderForShadow(files);
      log(`   orderForShadow: ${of.length} files`);
    } catch (e) {
      log(`   orderForShadow: THROWS ${oneLine(e).slice(0, 160)}`);
    }
  } catch (e) {
    log(`   pg-delta sql-order: ${oneLine(e)}`);
  }

  const OUT = here("../output/");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}results.json`, `${JSON.stringify(results, null, 2)}\n`);
  log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Details: prototype-pg-topo-pg18/output/`);
  writeFileSync(`${OUT}console.txt`, `${lines.join("\n")}\n`);
} finally {
  await stopCluster();
}
