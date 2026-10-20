// THROWAWAY: how long does static analysis + ordering take on a big synthetic schema?
// node src/scale.ts 1000   (5 statements per unit: table, index, comment, function, view)
import { analyze, init, order, type SqlFile } from "./analyze.ts";

await init();
const N = Number(process.argv[2] ?? 200);
const files: SqlFile[] = [];
for (let i = 0; i < N; i++) {
  const prev = Math.max(0, i - 1);
  files.push({ name: `t${i}.sql`, sql: `create table t${i} (id int primary key, p int references t${prev}(id), v text default f${i}(1));\ncreate index t${i}_v on t${i} (v);\ncomment on table t${i} is 'x';` });
  files.push({ name: `f${i}.sql`, sql: `create function f${i}(x int) returns text language sql immutable as $$ select 'a' || x $$;` });
  files.push({ name: `v${i}.sql`, sql: `create view v${i} as select t.id, f${i}(t.id) from t${i} t join t${prev} u on u.id = t.p;` });
}
const builtins = { funcs: new Set<string>(), types: new Set(["text"]), rels: new Set<string>() };
const t0 = performance.now();
const a = analyze(files, builtins);
const t1 = performance.now();
const o = order(a);
const t2 = performance.now();
console.log(`${a.statements.length} statements, ${a.edges.length} edges: analyze ${(t1 - t0).toFixed(0)} ms, order ${(t2 - t1).toFixed(0)} ms, cycle=${!!o.cycle}`);
