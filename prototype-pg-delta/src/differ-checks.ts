// THROWAWAY spike (issue 01). Acceptance criteria 1-3: column order, object
// coverage round trips, byte-identical output.
import { catalogDifferences } from "./catalog.ts";
import { diffDatabases, type DiffResult } from "./differ.ts";
import { applyInOneTransaction, dropDb, freshDb, runSql } from "./pg.ts";
import { CASES } from "./scenarios.ts";

export interface RoundTrip {
  name: string;
  statements: number;
  sql: string;
  sha256: string;
  applyError?: string;
  /** pg-delta's own re-diff after applying (spec §2 verification) */
  rediffStatements?: number;
  rediffSql?: string;
  /** engine-independent pg_catalog comparison after applying */
  catalogDiff?: string[];
  nonTransactional: string[];
  diagnostics: string[];
  ok: boolean;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** noise shifts OIDs/creation order so determinism is tested on genuinely different catalogs */
function noise(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += `create table zz_noise_${i} (x int); drop table zz_noise_${i};\n`;
  return s;
}

export async function roundTrip(name: string, from: string, to: string, noiseLevel = 0): Promise<RoundTrip> {
  const s = await freshDb("src");
  const d = await freshDb("dst");
  await runSql(s, noise(noiseLevel) + from);
  await runSql(d, noise(noiseLevel * 2) + to);
  let r: DiffResult;
  try {
    r = await diffDatabases(s, d);
  } catch (e) {
    return { name, statements: -1, sql: "", sha256: "", applyError: `PLAN FAILED: ${msg(e)}`, nonTransactional: [], diagnostics: [], ok: false };
  }
  const out: RoundTrip = {
    name,
    statements: r.statements.length,
    sql: r.sql,
    sha256: r.sha256,
    nonTransactional: r.nonTransactional.map((a) => `${a.transactionality}: ${a.sql}`),
    diagnostics: r.extractDiagnostics,
    ok: false,
  };
  try {
    await applyInOneTransaction(s, r.statements);
  } catch (e) {
    out.applyError = msg(e);
    return out;
  }
  const again = await diffDatabases(s, d);
  out.rediffStatements = again.statements.length;
  out.rediffSql = again.sql;
  out.catalogDiff = await catalogDifferences(s, d);
  out.ok = out.rediffStatements === 0 && out.catalogDiff.length === 0 && out.nonTransactional.length === 0;
  return out;
}

export async function coverage(noiseLevel = 0): Promise<RoundTrip[]> {
  const results: RoundTrip[] = [];
  for (const c of CASES) {
    results.push(await roundTrip(`${c.name} / create`, c.a, c.b, noiseLevel));
    results.push(await roundTrip(`${c.name} / alter`, c.b, c.c, noiseLevel));
    results.push(await roundTrip(`${c.name} / drop`, c.c, c.a, noiseLevel));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Column order

export interface ColumnOrderResult {
  name: string;
  detail: string;
  ok: boolean;
  sql?: string;
}

async function attnums(pool: import("pg").Pool, rel: string): Promise<string> {
  const { rows } = await pool.query(
    `select string_agg(attname, ',' order by attnum) as cols from pg_attribute
     where attrelid = $1::regclass and attnum > 0 and not attisdropped`,
    [rel],
  );
  return rows[0].cols as string;
}

export async function columnOrder(): Promise<ColumnOrderResult[]> {
  const out: ColumnOrderResult[] = [];

  // 1. column already exists at the end; desired has it mid-table -> no diff
  {
    const s = await freshDb("co_src");
    const d = await freshDb("co_dst");
    await runSql(s, `create table t (id int primary key, a text, c text); alter table t add column b text;`);
    await runSql(d, `create table t (id int primary key, a text, b text, c text);`);
    const r = await diffDatabases(s, d);
    out.push({
      name: "existing column at end vs desired mid-table",
      detail: `target cols=${await attnums(s, "t")}, desired cols=${await attnums(d, "t")}, statements=${r.statements.length}`,
      ok: r.statements.length === 0 && (await catalogDifferences(s, d)).length === 0,
      sql: r.sql,
    });
    await dropDb(s);
    await dropDb(d);
  }

  // 2. column added mid-table in desired -> plain ADD COLUMN (appended), then no diff
  {
    const s = await freshDb("co_src");
    const d = await freshDb("co_dst");
    await runSql(s, `create table t (id int primary key, a text, c text); insert into t values (1, 'a', 'c');`);
    await runSql(d, `create table t (id int primary key, a text, b text, c text);`);
    const r = await diffDatabases(s, d);
    await applyInOneTransaction(s, r.statements);
    const again = await diffDatabases(s, d);
    const rows = (await s.query("select count(*)::int as n from t")).rows[0].n;
    const onlyAdd = r.statements.length === 1 && /ADD COLUMN "b"/.test(r.statements[0]!);
    out.push({
      name: "desired adds column mid-table",
      detail: `plan=${JSON.stringify(r.statements)}; after apply target cols=${await attnums(s, "t")}; rows kept=${rows}; re-diff statements=${again.statements.length}`,
      ok: onlyAdd && again.statements.length === 0 && rows === 1,
      sql: r.sql,
    });
    await dropDb(s);
    await dropDb(d);
  }

  // 3. a view with SELECT * over the table: view column order IS visible
  {
    const s = await freshDb("co_src");
    const d = await freshDb("co_dst");
    await runSql(s, `create table t (id int primary key, a text, c text); alter table t add column b text; create view v as select * from t;`);
    await runSql(d, `create table t (id int primary key, a text, b text, c text); create view v as select * from t;`);
    let detail = "";
    let ok = false;
    let sql = "";
    try {
      const r = await diffDatabases(s, d);
      sql = r.sql;
      detail = `plan=${JSON.stringify(r.statements)}`;
      await applyInOneTransaction(s, r.statements);
      const again = await diffDatabases(s, d);
      detail += `; view cols after=${await attnums(s, "v")} (desired ${await attnums(d, "v")}); re-diff=${again.statements.length}; catalog diff=${JSON.stringify(await catalogDifferences(s, d))}`;
      ok = again.statements.length === 0;
    } catch (e) {
      detail += ` ERROR ${msg(e)}`;
    }
    out.push({ name: "view SELECT * over a table whose physical order differs (informational)", detail, ok, sql });
    await dropDb(s);
    await dropDb(d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Determinism

export interface DeterminismResult {
  name: string;
  hashes: string[];
  identical: boolean;
}

export async function determinism(runs = 3): Promise<DeterminismResult[]> {
  const perRun: RoundTrip[][] = [];
  for (let i = 0; i < runs; i++) perRun.push(await coverage(i * 3));
  const out: DeterminismResult[] = perRun[0]!.map((r, idx) => {
    const hashes = perRun.map((run) => run[idx]!.sha256);
    return { name: r.name, hashes, identical: hashes.every((h) => h === hashes[0]) };
  });

  // whole schema at once, desired loaded forward vs reversed (different OIDs and creation order)
  const blocks = CASES.map((c, i) => `create schema c${i}; set search_path = c${i}, public;\n${c.c}\nreset search_path;`);
  const fullHashes: string[] = [];
  for (let i = 0; i < runs; i++) {
    const s = await freshDb("det_src");
    const d = await freshDb("det_dst");
    const ordered = i % 2 === 0 ? blocks : [...blocks].reverse();
    await runSql(d, noise(i * 5) + ordered.join("\n"));
    const r = await diffDatabases(s, d);
    fullHashes.push(`${r.sha256.slice(0, 16)} (${r.statements.length} stmts)`);
    await dropDb(s);
    await dropDb(d);
  }
  out.push({ name: "ALL cases in one database, empty -> full (forward/reverse load)", hashes: fullHashes, identical: fullHashes.every((h) => h === fullHashes[0]) });
  return out;
}
