// THROWAWAY spike for issue 01 (.scratch/super-deploy/issues/01-prototype-pg-delta-differ.md).
// Run from the repo root with: pnpm prototype:pg-delta
// Starts a private PostgreSQL 18 (embedded-postgres), creates databases named
// prototype_pg_delta_wipe_me*, runs every check, prints a summary and writes
// prototype-pg-delta/output/. The cluster and its data dir are deleted at the end.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { columnOrder, coverage, determinism } from "./differ-checks.ts";
import { q35 } from "./loader.ts";
import { PREFIX, startCluster, stopCluster } from "./pg.ts";

const lines: string[] = [];
function log(s: string): void {
  lines.push(s);
  process.stdout.write(`${s}\n`);
}

const OUT = fileURLToPath(new URL("../output/", import.meta.url));
const require = createRequire(import.meta.url);
function version(pkg: string): string {
  try {
    return JSON.parse(readFileSync(require.resolve(`${pkg}/package.json`), "utf8")).version;
  } catch {
    // packages whose exports map hides package.json
    const p = fileURLToPath(new URL(`../node_modules/${pkg}/package.json`, import.meta.url));
    return JSON.parse(readFileSync(p, "utf8")).version;
  }
}

const versions = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  "@supabase/pg-delta": version("@supabase/pg-delta"),
  "@supabase/pg-topo": version("@supabase/pg-topo"),
  "embedded-postgres": version("embedded-postgres"),
  pg: version("pg"),
};

const t0 = Date.now();
const server = await startCluster();
log(`PostgreSQL: ${server}\nDatabases: ${PREFIX}*\nVersions: ${JSON.stringify(versions)}\n`);
const only = process.env.PROTOTYPE_ONLY; // e.g. "q35" to iterate on one section
const skip = (k: string) => only !== undefined && only !== k;
try {
  log("== 1. Column order");
  const co = skip("differ") ? [] : await columnOrder();
  for (const r of co) log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.name}\n         ${r.detail}`);

  log("\n== 2. Object coverage round trips (create a->b, alter b->c, drop c->a)");
  const cov = skip("differ") ? [] : await coverage();
  for (const r of cov) {
    const why = r.ok
      ? ""
      : ` <- ${r.applyError ? `apply error: ${r.applyError}` : ""}${r.rediffStatements ? ` re-diff not empty (${r.rediffStatements})` : ""}${r.catalogDiff?.length ? ` catalog differs: ${r.catalogDiff.join(" | ")}` : ""}${r.nonTransactional.length ? ` non-transactional: ${r.nonTransactional.join(" | ")}` : ""}`;
    log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.name} (${r.statements} stmts)${why}`);
  }

  log("\n== 3. Determinism (3 runs, fresh databases, shifted OIDs, reversed load order)");
  const det = skip("differ") ? [] : await determinism(3);
  const nonDet = det.filter((d) => !d.identical);
  log(`  ${det.length - nonDet.length}/${det.length} outputs byte-identical across runs`);
  for (const d of nonDet) log(`  [FAIL] ${d.name}: ${d.hashes.join(" ")}`);
  if (det.length) log(`  ${det.at(-1)!.name}: ${det.at(-1)!.hashes.join(" ")}`);

  log("\n== 4. Q35 directory loader");
  const q = skip("q35") ? { fixtures: [], pgTopo: [], sortExample: {} } : await q35();
  for (const f of q.fixtures) {
    log(`  -- ${f.fixture}`);
    for (const a of f.attempts) {
      const same = a.vsReference === undefined ? "" : a.vsReference.length === 0 ? " same-as-reference" : ` DIFFERS-from-reference(${a.vsReference.length}): ${a.vsReference.join(" | ").slice(0, 300)}`;
      const pick = a.pickBinding ? ` view binds pick(${a.pickBinding})` : "";
      log(`     [${a.loaded ? "loaded" : "FAILED"}] ${a.method}${same}${pick}${a.extra ? ` (${a.extra})` : ""}`);
      if (a.error) log(`         error: ${a.error}`);
      for (const w of a.warnings.slice(0, 4)) log(`         warn: ${w.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  log("  -- pg-topo (PG17 grammar) on PG18 syntax");
  for (const p of q.pgTopo) log(`     [${p.parsed ? "parsed" : "PARSE FAIL"}] ${p.statement} ${p.diagnostics.join("; ").slice(0, 200)}`);
  log("  -- path sorting");
  for (const [k, v] of Object.entries(q.sortExample)) log(`     ${k}: ${v.join("  ")}`);

  if (only) process.exit(0);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${OUT}schema-changes`, { recursive: true });
  for (const [i, r] of cov.entries()) {
    const file = `${String(i).padStart(3, "0")}-${r.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.sql`;
    writeFileSync(`${OUT}schema-changes/${file}`, `-- ${r.name}\n-- ok=${r.ok}\n${r.sql}${r.rediffSql ? `\n-- RE-DIFF AFTER APPLY (should be empty):\n${r.rediffSql}` : ""}`);
  }
  writeFileSync(`${OUT}results.json`, `${JSON.stringify({ versions, server, columnOrder: co, coverage: cov, determinism: det, q35: q }, null, 2)}\n`);
  const passed = cov.filter((r) => r.ok).length;
  log(`\nSummary: column order ${co.filter((r) => r.ok).length}/${co.length}, coverage ${passed}/${cov.length}, determinism ${det.length - nonDet.length}/${det.length}. ${((Date.now() - t0) / 1000).toFixed(0)}s. Details: prototype-pg-delta/output/`);
  writeFileSync(`${OUT}console.txt`, `${lines.join("\n")}\n`);
} finally {
  await stopCluster();
}
