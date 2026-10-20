// THROWAWAY spike for Q35 (automatic, deterministic ordering of desired-schema statements).
// Run from the repo root with: pnpm prototype:schema-ordering
// Starts a private PostgreSQL 18 (embedded-postgres), creates only databases named
// prototype_schema_ordering_wipe_me*, prints a summary and writes prototype-schema-ordering/output/.
// The cluster and its data dir are deleted at the end.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze, cycleMessage, init, order, type Analysis, type AnalyzeOptions, type SqlFile, type TieBreak } from "./analyze.ts";
import { builtinNames, differences, loadFiles, loadPgDelta, loadStatements, pathOrder, readFixture, snapshot } from "./load.ts";
import { dropDb, freshDb, PREFIX, startCluster, stopCluster } from "./pg.ts";

const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  process.stdout.write(`${s}\n`);
};
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const FIXTURES: [string, string][] = [
  ["q35-shuffled (from prototype-pg-delta)", here("../../prototype-pg-delta/fixtures/q35-shuffled")],
  ["q35-overload-binding (from prototype-pg-delta)", here("../../prototype-pg-delta/fixtures/q35-overload-binding")],
  ["overloads", here("../fixtures/overloads")],
  ["overload-ambiguous", here("../fixtures/overload-ambiguous")],
  ["extraction-gap", here("../fixtures/extraction-gap")],
  ["domain-composite", here("../fixtures/domain-composite")],
  ["view-chain", here("../fixtures/view-chain")],
  ["sql-functions", here("../fixtures/sql-functions")],
  ["triggers-policies", here("../fixtures/triggers-policies")],
  ["fk-index-choice", here("../fixtures/fk-index-choice")],
  ["unnamed-index", here("../fixtures/unnamed-index")],
  ["cycle-error", here("../fixtures/cycle-error")],
  ["unresolved", here("../fixtures/unresolved")],
];

const ALT_ORDERS: TieBreak[] = ["reverse", "reverse-ignore-priority", { seed: 1 }, { seed: 2 }, { seed: 3 }];
const label = (m: TieBreak) => (typeof m === "object" ? `random-valid(seed ${m.seed})` : m);

interface Outcome {
  method: string;
  loaded: boolean;
  error?: string;
  diffVsStatic?: string[];
  note?: string;
}

async function attempt(method: string, ref: string[] | undefined, fn: (pool: Awaited<ReturnType<typeof freshDb>>) => Promise<string | undefined | { error?: string; note?: string }>): Promise<Outcome> {
  const pool = await freshDb("load");
  try {
    const r = await fn(pool);
    const error = typeof r === "string" ? r : r?.error;
    const note = typeof r === "object" ? r.note : undefined;
    if (error) return { method, loaded: false, error, note };
    return { method, loaded: true, note, diffVsStatic: ref ? differences(ref, await snapshot(pool)) : undefined };
  } finally {
    await dropDb(pool);
  }
}

function show(o: Outcome): void {
  const same = o.diffVsStatic === undefined ? "" : o.diffVsStatic.length === 0 ? " -> SAME catalog as static order" : ` -> DIFFERENT catalog (${o.diffVsStatic.length} lines)`;
  log(`     [${o.loaded ? "loaded" : "FAILED"}] ${o.method}${same}${o.note ? ` (${o.note})` : ""}`);
  if (o.error) log(`         error: ${o.error}`);
  for (const d of (o.diffVsStatic ?? []).slice(0, 6)) log(`         ${d.slice(0, 220)}`);
}

/** Determinism guard: load the same statements in other VALID orders and compare catalogs. */
async function guard(a: Analysis, ref: string[], tag: string): Promise<{ order: string; same: boolean; error?: string; diff: string[] }[]> {
  const res = [];
  for (const m of ALT_ORDERS) {
    const o = order(a, m);
    const out = await attempt(`${tag} ${label(m)}`, ref, (p) => loadStatements(p, o.order));
    res.push({ order: label(m), same: out.loaded && out.diffVsStatic!.length === 0, error: out.error, diff: out.diffVsStatic ?? [] });
  }
  return res;
}

/** File-name invariance: one file per statement, random names, reverse statement order. Order must not change. */
function invariance(a: Analysis, files: SqlFile[], builtins: Parameters<typeof analyze>[1]): boolean {
  const base = order(a).order.map((s) => s.hash);
  const n = a.statements.length;
  const renamed = [...a.statements].reverse().map((s, i) => ({ name: `zz${((i * 7919) % 1000).toString(36)}/${(n - i).toString().padStart(3, "0")}.sql`, sql: `${s.text};\n` }));
  const b = analyze(renamed, builtins);
  void files;
  return JSON.stringify(order(b).order.map((s) => s.hash)) === JSON.stringify(base);
}

const t0 = Date.now();
const server = await startCluster();
log(`PostgreSQL: ${server}\nDatabases: ${PREFIX}*\n`);
await init();
const results: unknown[] = [];
try {
  const probe = await freshDb("builtins");
  const builtins = await builtinNames(probe);
  await dropDb(probe);

  for (const [name, dir] of FIXTURES) {
    const files = readFixture(dir);
    log(`\n== ${name}: ${files.length} files`);
    const ta = performance.now();
    const a = analyze(files, builtins);
    const o = order(a);
    const ms = (performance.now() - ta).toFixed(1);
    const errors = a.findings.filter((f) => f.level === "error");
    const lints = a.findings.filter((f) => f.level === "lint");
    log(`   static analysis: ${a.statements.length} statements, ${a.edges.length} edges, ${errors.length} errors, ${lints.length} lints, ${ms} ms`);
    for (const f of [...errors, ...lints]) log(`     ${f.level.toUpperCase()} ${f.code}: ${f.message}`);
    if (o.cycle) log(`     ERROR CYCLE: ${cycleMessage(o.cycle, a)}`);
    const refused = errors.length > 0 || !!o.cycle;
    if (!refused) log(`   static order: ${o.order.map((s) => s.identity).join("  |  ")}`);

    const fixtureResult: Record<string, unknown> = {
      fixture: name,
      files: files.map((f) => f.name),
      statements: a.statements.map((s) => ({ at: `${s.file}:${s.line}`, identity: s.identity, provides: s.provides, requires: s.requires })),
      findings: a.findings,
      cycle: o.cycle ? cycleMessage(o.cycle, a) : undefined,
      staticOrder: refused ? undefined : o.order.map((s) => s.identity),
      analysisMs: Number(ms),
    };

    let ref: string[] | undefined;
    if (!refused) {
      const out = await attempt("static order (ours), one transaction, fail fast", undefined, async (p) => {
        const err = await loadStatements(p, o.order);
        if (!err) ref = await snapshot(p);
        return err;
      });
      show(out);
      fixtureResult.staticLoad = out;
      fixtureResult.fileNameInvariant = invariance(a, files, builtins);
      log(`     file names / statement order invariance (one file per statement, random names, reversed): ${fixtureResult.fileNameInvariant ? "same order" : "ORDER CHANGED"}`);
    }

    const comparisons: Outcome[] = [];
    comparisons.push(await attempt("path order (spec fallback), one pass", ref, (p) => loadFiles(p, pathOrder(files))));
    comparisons.push(await attempt("REVERSE path order, one pass", ref, (p) => loadFiles(p, pathOrder(files).reverse())));
    comparisons.push(
      await attempt("pg-delta loadSqlFiles (lexicographic + retry rounds + statement fallback)", ref, async (p) => {
        const r = await loadPgDelta(p, files);
        return { error: r.error, note: r.rounds !== undefined ? `rounds=${r.rounds}${r.warnings.length ? `, ${r.warnings.length} warnings` : ""}` : undefined };
      }),
    );
    for (const c of comparisons) show(c);
    fixtureResult.comparisons = comparisons;
    if (!ref && comparisons[0]!.loaded) {
      // no static result to compare with: does the outcome of the file-order loaders depend on file names?
      let pathRef: string[] | undefined;
      await attempt("path order (again, as reference)", undefined, async (p) => {
        const err = await loadFiles(p, pathOrder(files));
        if (!err) pathRef = await snapshot(p);
        return err;
      });
      const rev = await attempt("REVERSE path order compared with path order", pathRef, (p) => loadFiles(p, pathOrder(files).reverse()));
      log(`     reverse path order vs path order: ${rev.loaded ? (rev.diffVsStatic!.length ? `DIFFERENT: ${rev.diffVsStatic!.slice(0, 4).join(" | ")}` : "same") : `failed: ${rev.error}`}`);
      fixtureResult.reverseVsPath = rev;
    }

    if (ref) {
      log("   determinism guard (same statements, other valid topological orders):");
      const g = await guard(a, ref, "ours");
      for (const r of g) log(`     ${r.same ? "same" : "DIFFERENT"}: ${r.order}${r.error ? ` error: ${r.error}` : ""}${r.diff.length ? ` ${r.diff.slice(0, 4).join(" | ").slice(0, 400)}` : ""}`);
      fixtureResult.guard = g;
      log(`   guard verdict: ${g.every((r) => r.same) ? "order-independent (PASS)" : "ORDER-DEPENDENT: would be refused"}`);

      if (a.findings.some((f) => f.code === "OVERLOADED_REFERENCE")) {
        const opts: AnalyzeOptions = { overloadEdges: "one" };
        const ab = analyze(files, builtins, opts);
        const abo = order(ab);
        let abRef: string[] | undefined;
        const out = await attempt("ABLATION static order with one-overload edges", undefined, async (p) => {
          const err = await loadStatements(p, abo.order);
          if (!err) abRef = await snapshot(p);
          return err;
        });
        log("   ablation (edges to ONE overload only, i.e. without the all-overloads rule):");
        show(out);
        if (abRef) {
          const g2 = await guard(ab, abRef, "ablation");
          for (const r of g2) log(`     ${r.same ? "same" : "DIFFERENT"}: ${r.order}${r.error ? ` error: ${r.error}` : ""}${r.diff.length ? ` ${r.diff.slice(0, 4).join(" | ").slice(0, 400)}` : ""}`);
          log(`   ablation guard verdict: ${g2.every((r) => r.same) ? "order-independent" : "ORDER-DEPENDENT: guard catches it"}`);
          fixtureResult.ablationGuard = g2;
        }
      }
    }
    results.push(fixtureResult);
  }

  const OUT = here("../output/");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}results.json`, `${JSON.stringify({ server, results }, null, 2)}\n`);
  log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Details: prototype-schema-ordering/output/`);
  writeFileSync(`${OUT}console.txt`, `${lines.join("\n")}\n`);
} finally {
  await stopCluster();
}
