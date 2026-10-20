// THROWAWAY spike (Q35). Static ordering of desired-schema statements with
// libpg-query@18: split files into statements, extract what each statement
// provides and requires, then topologically sort STATEMENTS (not files) with a
// tie-break that depends only on statement content, never on file names.
import { createHash } from "node:crypto";
import { loadModule, parseSync } from "libpg-query";

export interface SqlFile {
  name: string;
  sql: string;
}

/** Names that exist in pg_catalog on the PG18 server (read once from a live database). */
export interface BuiltinNames {
  funcs: Set<string>;
  types: Set<string>;
  rels: Set<string>;
}

export interface Stmt {
  id: number;
  file: string;
  line: number;
  text: string;
  kind: string;
  /** 0 = structural graph, 1 = decorations (RLS switches, GRANT, COMMENT): always after every structural statement */
  phase: 0 | 1;
  priority: number;
  identity: string;
  hash: string;
  provides: string[];
  requires: string[];
  /** true if references in this statement are resolved and frozen at CREATE time */
  bindsAtCreate: boolean;
}

export interface Finding {
  level: "error" | "lint";
  code: string;
  message: string;
}

export interface Analysis {
  statements: Stmt[];
  edges: [number, number][];
  findings: Finding[];
}

export interface AnalyzeOptions {
  /** "all" (default): a reference to function name f waits for EVERY overload of f.
   *  "one": ABLATION ONLY, waits for one arbitrary overload (what a naive resolver would do). */
  overloadEdges?: "all" | "one";
}

const MANAGED = "public";

// pg_dump-inspired kind priority. Only a tie-break: edges always win.
const PRIORITY: Record<string, number> = {
  extension: 0,
  type: 10,
  domain: 11,
  table: 20,
  function: 30,
  procedure: 31,
  view: 40,
  matview: 41,
  constraint: 50,
  index: 60,
  trigger: 70,
  policy: 80,
  rls: 90,
  grant: 91,
  comment: 92,
};

let loaded = false;
export async function init(): Promise<void> {
  if (!loaded) await loadModule();
  loaded = true;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const strs = (list: unknown): string[] =>
  Array.isArray(list) ? list.map((n) => ((n as Json).String as Json | undefined)?.sval as string).filter((s) => s !== undefined) : [];

class Collector {
  rels = new Set<string>();
  types = new Set<string>();
  funcs = new Set<string>();
  ctes = new Set<string>();
  foreign: string[] = []; // FK referenced tables
  outside: string[] = []; // references to schemas other than managed / pg_catalog

  qualified(parts: string[], what: string): string | undefined {
    if (parts.length === 1) return parts[0];
    const [schema, name] = parts.length === 2 ? parts : [parts[1], parts[2]];
    if (schema === "pg_catalog") return undefined; // explicitly built-in
    if (schema === MANAGED) return name;
    this.outside.push(`${what} ${parts.join(".")}`);
    return undefined;
  }

  rangeVar(rv: Json): void {
    const parts = [rv.catalogname, rv.schemaname, rv.relname].filter((x) => typeof x === "string") as string[];
    const n = this.qualified(parts, "relation");
    if (n !== undefined) this.rels.add(parts.length === 1 ? `?${n}` : n); // "?" = unqualified, may be a CTE
  }

  typeName(tn: Json): void {
    if (tn.pct_type) {
      // table.column%TYPE: resolved at CREATE against the table
      const n = this.qualified(strs(tn.names).slice(0, -1), "relation");
      if (n !== undefined) this.rels.add(n);
      return;
    }
    const n = this.qualified(strs(tn.names), "type");
    if (n !== undefined) this.types.add(n);
  }

  funcName(list: unknown): void {
    const n = this.qualified(strs(list), "function");
    if (n !== undefined) this.funcs.add(n);
  }

  walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const n of node) this.walk(n);
      return;
    }
    if (!isObj(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (!isObj(v) && !Array.isArray(v)) continue;
      if (k === "RangeVar" && isObj(v)) this.rangeVar(v);
      else if (isObj(v) && "relname" in v && "relpersistence" in v) this.rangeVar(v); // unwrapped RangeVar field
      else if (k === "FuncCall" && isObj(v)) {
        this.funcName(v.funcname);
        this.walk(v);
      } else if (k === "CommonTableExpr" && isObj(v)) {
        this.ctes.add(v.ctename as string);
        this.walk(v);
      } else if (k === "TypeCast" && isObj(v)) {
        this.regLiteral(v);
        this.walk(v);
      } else if ((k === "TypeName" || ("names" in (v as Json) && "typemod" in (v as Json))) && isObj(v)) {
        this.typeName(v);
        this.walk(v);
      } else if (k === "Constraint" && isObj(v) && v.contype === "CONSTR_FOREIGN" && isObj(v.pktable)) {
        const t = this.qualified(
          [v.pktable.schemaname, v.pktable.relname].filter((x) => typeof x === "string") as string[],
          "relation",
        );
        if (t) this.foreign.push(t);
        this.walk(v);
      } else this.walk(v);
    }
  }

  /** 'name'::regclass / ::regtype / ::regproc literals are resolved to OIDs at CREATE */
  regLiteral(tc: Json): void {
    const tn = strs((tc.typeName as Json | undefined)?.names).at(-1);
    const sval = (((tc.arg as Json | undefined)?.A_Const as Json | undefined)?.sval as Json | undefined)?.sval as string | undefined;
    if (!tn || sval === undefined) return;
    const parts = sval.split(".").map((p) => p.replace(/^"|"$/g, ""));
    const name = parts.at(-1)!.replace(/\(.*$/, "");
    if (parts.length > 1 && parts[0] !== MANAGED) return;
    if (tn === "regclass") this.rels.add(name);
    if (tn === "regtype") this.types.add(name);
    if (tn === "regproc" || tn === "regprocedure") this.funcs.add(name);
  }
}

function typeText(tn: Json | undefined): string {
  if (!tn) return "?";
  const names = strs(tn.names).filter((n, i, a) => !(i === 0 && n === "pg_catalog" && a.length > 1));
  return names.join(".") + (Array.isArray(tn.arrayBounds) ? "[]" : "");
}

function lineOf(buf: Buffer, byteOffset: number): number {
  let line = 1;
  for (let i = 0; i < byteOffset && i < buf.length; i++) if (buf[i] === 10) line++;
  return line;
}

/** Split one file into statements using the PG18 parser's own statement boundaries. */
function split(file: SqlFile): { text: string; line: number; stmt: Json }[] {
  const res = parseSync(file.sql) as unknown as { stmts?: Json[] };
  const buf = Buffer.from(file.sql, "utf8");
  return (res.stmts ?? []).map((raw) => {
    const loc = (raw.stmt_location as number | undefined) ?? 0;
    const len = (raw.stmt_len as number | undefined) ?? 0;
    const text = buf
      .subarray(loc, len ? loc + len : buf.length)
      .toString("utf8")
      .trim();
    return { text, line: lineOf(buf, loc), stmt: raw.stmt as Json };
  });
}

interface Extracted {
  kind: string;
  identity: string;
  provides: string[];
  self: string[]; // names this statement defines itself (never a requirement)
  bindsAtCreate: boolean;
  c: Collector;
  softRequires: string[]; // requirements that may legitimately stay unresolved (auto-named objects)
  findings: Finding[];
}

function extract(stmt: Json): Extracted {
  const [type, body] = Object.entries(stmt)[0] as [string, Json];
  const c = new Collector();
  const out: Extracted = { kind: "?", identity: "?", provides: [], self: [], bindsAtCreate: true, c, softRequires: [], findings: [] };
  const rvName = (rv: unknown) => (isObj(rv) ? (rv.relname as string) : "?");
  switch (type) {
    case "CreateExtensionStmt": {
      out.kind = "extension";
      out.identity = `extension ${body.extname}`;
      if (body.extname !== "plpgsql") out.findings.push({ level: "error", code: "REFUSED", message: `extension ${body.extname} is refused (spec 4.1)` });
      return out;
    }
    case "CreateStmt": {
      const t = rvName(body.relation);
      out.kind = "table";
      out.identity = `table ${t}`;
      out.provides.push(`rel:${t}`, `type:${t}`);
      out.self.push(t);
      c.walk(body.tableElts);
      // inline unique keys and named constraints
      const cons: [Json, string[]][] = [];
      for (const el of (body.tableElts as Json[]) ?? []) {
        if (isObj(el.Constraint)) cons.push([el.Constraint, strs(el.Constraint.keys)]);
        const cd = el.ColumnDef as Json | undefined;
        for (const cc of ((cd?.constraints as Json[]) ?? []).map((x) => x.Constraint as Json)) cons.push([cc, [cd!.colname as string]]);
      }
      for (const [k, cols] of cons) {
        if (k.contype === "CONSTR_PRIMARY") out.provides.push(`uniq:${t}`, `rel:${(k.indexname as string) ?? `${t}_pkey`}`);
        if (k.contype === "CONSTR_UNIQUE") out.provides.push(`uniq:${t}`);
        if (k.contype === "CONSTR_PRIMARY" || k.contype === "CONSTR_UNIQUE") out.provides.push(`uniqcols:${t}(${[...cols].sort().join(",")})`);
        if (k.conname) out.provides.push(`con:${t}.${k.conname}`);
      }
      return out;
    }
    case "ViewStmt": {
      const v = rvName(body.view);
      out.kind = "view";
      out.identity = `view ${v}`;
      out.provides.push(`rel:${v}`, `type:${v}`);
      out.self.push(v);
      c.walk(body.query);
      return out;
    }
    case "CreateTableAsStmt": {
      const v = rvName((body.into as Json | undefined)?.rel);
      if (body.objtype !== "OBJECT_MATVIEW") out.findings.push({ level: "error", code: "REFUSED", message: "CREATE TABLE AS is refused" });
      out.kind = "matview";
      out.identity = `matview ${v}`;
      out.provides.push(`rel:${v}`, `type:${v}`);
      out.self.push(v);
      c.walk(body.query);
      return out;
    }
    case "CompositeTypeStmt": {
      const n = rvName(body.typevar);
      out.kind = "type";
      out.identity = `type ${n}`;
      out.provides.push(`type:${n}`, `rel:${n}`);
      out.self.push(n);
      c.walk(body.coldeflist);
      return out;
    }
    case "CreateDomainStmt": {
      const n = strs(body.domainname).at(-1)!;
      out.kind = "domain";
      out.identity = `domain ${n}`;
      out.provides.push(`type:${n}`);
      out.self.push(n);
      c.walk(body.typeName ? { TypeName: body.typeName } : undefined);
      c.walk(body.constraints);
      return out;
    }
    case "CreateFunctionStmt": {
      const name = strs(body.funcname).at(-1)!;
      const params = ((body.parameters as Json[]) ?? []).map((p) => p.FunctionParameter as Json);
      const sig = params
        .filter((p) => ["FUNC_PARAM_DEFAULT", "FUNC_PARAM_IN", "FUNC_PARAM_INOUT", "FUNC_PARAM_VARIADIC"].includes(p.mode as string))
        .map((p) => typeText(p.argType as Json));
      out.kind = body.is_procedure ? "procedure" : "function";
      out.identity = `${out.kind} ${name}(${sig.join(",")})`;
      out.provides.push(`func:${name}`);
      c.walk(body.parameters);
      if (body.returnType) c.walk({ TypeName: body.returnType });
      const opts = ((body.options as Json[]) ?? []).map((o) => o.DefElem as Json);
      const lang = (opts.find((o) => o.defname === "language")?.arg as Json | undefined)?.String as Json | undefined;
      const language = (lang?.sval as string | undefined) ?? (body.sql_body ? "sql" : "?");
      if (body.sql_body) {
        c.walk(body.sql_body); // BEGIN ATOMIC / RETURN: parsed and bound at CREATE, stored as a tree
      } else if (language === "sql") {
        // string body: validated at CREATE (check_function_bodies = on), so its objects must exist; re-bound at each call
        const as = opts.find((o) => o.defname === "as")?.arg as Json | undefined;
        const src = strs((as?.List as Json | undefined)?.items)[0] ?? "";
        try {
          const inner = parseSync(src) as unknown as { stmts?: Json[] };
          c.walk(inner.stmts);
        } catch (e) {
          out.findings.push({ level: "error", code: "BODY_PARSE", message: `cannot parse LANGUAGE sql body of ${out.identity}: ${(e as Error).message}` });
        }
      }
      // plpgsql: late-bound, body ignored for ordering (spec 4.3 rules are checked elsewhere)
      return out;
    }
    case "IndexStmt": {
      const t = rvName(body.relation);
      const n = body.idxname as string | undefined;
      out.kind = "index";
      out.identity = `index ${n ?? `(unnamed) on ${t}`}`;
      if (n) out.provides.push(`rel:${n}`);
      else out.findings.push({ level: "lint", code: "UNNAMED_INDEX", message: `unnamed index on ${t}: its generated name depends on which other unnamed indexes exist first` });
      if (body.unique) out.provides.push(`uniq:${t}`);
      if (body.unique && !body.whereClause) {
        const cols = ((body.indexParams as Json[]) ?? []).map((p) => ((p.IndexElem as Json).name as string | undefined) ?? "(expr)");
        out.provides.push(`uniqcols:${t}(${[...cols].sort().join(",")})`);
      }
      c.walk(body);
      return out;
    }
    case "CreateTrigStmt": {
      const t = rvName(body.relation);
      out.kind = "trigger";
      out.identity = `trigger ${t}.${body.trigname}`;
      out.provides.push(`trigger:${t}.${body.trigname}`);
      c.funcName(body.funcname);
      c.walk(body.relation ? { RangeVar: body.relation } : undefined);
      c.walk(body.whenClause);
      return out;
    }
    case "CreatePolicyStmt": {
      const t = rvName(body.table);
      out.kind = "policy";
      out.identity = `policy ${t}.${body.policy_name}`;
      out.provides.push(`policy:${t}.${body.policy_name}`);
      c.walk(body);
      return out;
    }
    case "AlterTableStmt": {
      const t = rvName(body.relation);
      const cmds = ((body.cmds as Json[]) ?? []).map((x) => x.AlterTableCmd as Json);
      c.walk({ RangeVar: body.relation });
      if (cmds.every((x) => x.subtype === "AT_EnableRowSecurity" || x.subtype === "AT_ForceRowSecurity")) {
        out.kind = "rls";
        out.identity = `rls ${t} ${cmds.map((x) => x.subtype).join(",")}`;
        out.bindsAtCreate = false;
        return out;
      }
      if (cmds.length !== 1 || cmds[0]!.subtype !== "AT_AddConstraint") {
        out.findings.push({ level: "error", code: "REFUSED", message: `ALTER TABLE ${t} form not allowed in the desired schema (only ADD CONSTRAINT, ENABLE/FORCE ROW LEVEL SECURITY)` });
        return out;
      }
      const k = (cmds[0]!.def as Json).Constraint as Json;
      out.kind = "constraint";
      out.identity = `constraint ${t}.${(k.conname as string) ?? "(unnamed)"}`;
      if (!k.conname) out.findings.push({ level: "lint", code: "UNNAMED_CONSTRAINT", message: `unnamed constraint added to ${t}: generated names can depend on order` });
      else out.provides.push(`con:${t}.${k.conname}`);
      if (k.contype === "CONSTR_PRIMARY" || k.contype === "CONSTR_UNIQUE") out.provides.push(`uniq:${t}`, `uniqcols:${t}(${strs(k.keys).sort().join(",")})`);
      if (k.contype === "CONSTR_PRIMARY") out.provides.push(`rel:${(k.indexname as string) ?? `${t}_pkey`}`);
      if ((k.contype === "CONSTR_PRIMARY" || k.contype === "CONSTR_UNIQUE") && k.conname) out.provides.push(`rel:${k.conname}`);
      c.walk(cmds[0]!.def);
      return out;
    }
    case "GrantStmt": {
      out.kind = "grant";
      out.bindsAtCreate = false;
      const what = (body.objects as Json[]) ?? [];
      for (const o of what) {
        if (isObj(o.ObjectWithArgs)) c.funcName(o.ObjectWithArgs.objname);
        c.walk(o);
      }
      const targets = what.map((o) => (isObj(o.ObjectWithArgs) ? strs(o.ObjectWithArgs.objname).join(".") : isObj(o.RangeVar) ? (o.RangeVar.relname as string) : "?"));
      out.identity = `${body.is_grant ? "grant" : "revoke"} ${(body.objtype as string).replace("OBJECT_", "").toLowerCase()} ${targets.join(",")}`;
      return out;
    }
    case "CommentStmt": {
      out.kind = "comment";
      out.bindsAtCreate = false;
      const obj = body.object as Json;
      const list = strs((obj?.List as Json | undefined)?.items ?? (isObj(obj?.String) ? [obj] : []));
      const ot = body.objtype as string;
      if (["OBJECT_TABLE", "OBJECT_VIEW", "OBJECT_MATVIEW", "OBJECT_INDEX"].includes(ot)) c.rels.add(list.at(-1)!);
      else if (ot === "OBJECT_COLUMN") c.rels.add(list.at(-2)!);
      else if (ot === "OBJECT_TABCONSTRAINT") {
        c.rels.add(list.at(-2)!);
        out.softRequires.push(`con:${list.at(-2)}.${list.at(-1)}`);
      } else if (ot === "OBJECT_TRIGGER") out.softRequires.push(`trigger:${list.at(-2)}.${list.at(-1)}`);
      else if (ot === "OBJECT_POLICY") out.softRequires.push(`policy:${list.at(-2)}.${list.at(-1)}`);
      else if (["OBJECT_FUNCTION", "OBJECT_PROCEDURE", "OBJECT_ROUTINE"].includes(ot)) c.funcName((obj.ObjectWithArgs as Json).objname);
      else if (["OBJECT_TYPE", "OBJECT_DOMAIN"].includes(ot)) c.walk(obj);
      const named = list.length
        ? list.join(".")
        : isObj(obj?.ObjectWithArgs)
          ? strs(obj.ObjectWithArgs.objname).join(".")
          : isObj(obj?.TypeName)
            ? typeText(obj.TypeName)
            : "?";
      out.identity = `comment ${ot.replace("OBJECT_", "").toLowerCase()} ${named}`;
      return out;
    }
    default:
      out.findings.push({ level: "error", code: "REFUSED", message: `${type} is not allowed in the desired schema` });
      return out;
  }
}

export function analyze(files: SqlFile[], builtins: BuiltinNames, opts: AnalyzeOptions = {}): Analysis {
  const findings: Finding[] = [];
  const statements: Stmt[] = [];
  const extracted: Extracted[] = [];
  // Files are visited in a fixed order only so that statement ids are stable; ids never decide the load order.
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    let parts: ReturnType<typeof split>;
    try {
      parts = split(f);
    } catch (e) {
      findings.push({ level: "error", code: "SYNTAX", message: `${f.name}: ${(e as Error).message}` });
      continue;
    }
    for (const p of parts) {
      const x = extract(p.stmt);
      const where = `${f.name}:${p.line}`;
      for (const fd of x.findings) findings.push({ ...fd, message: `${where}: ${fd.message}` });
      for (const o of x.c.outside) findings.push({ level: "error", code: "OTHER_SCHEMA", message: `${where}: ${o} is outside the managed schema and pg_catalog` });
      const norm = p.text.replace(/\s+/g, " ");
      statements.push({
        id: statements.length,
        file: f.name,
        line: p.line,
        text: p.text,
        kind: x.kind,
        phase: ["rls", "grant", "comment"].includes(x.kind) ? 1 : 0,
        priority: PRIORITY[x.kind] ?? 99,
        identity: x.identity,
        hash: createHash("sha256").update(norm).digest("hex").slice(0, 16),
        provides: x.provides,
        requires: [],
        bindsAtCreate: x.bindsAtCreate,
      });
      extracted.push(x);
    }
  }

  // producers
  const producers = new Map<string, number[]>();
  for (const s of statements) for (const k of s.provides) producers.set(k, [...(producers.get(k) ?? []), s.id]);
  for (const [k, ids] of producers) {
    if (ids.length > 1 && !k.startsWith("func:") && !k.startsWith("uniq")) {
      findings.push({ level: "error", code: "DUPLICATE", message: `${k.slice(k.indexOf(":") + 1)} is defined more than once: ${ids.map((i) => `${statements[i]!.file}:${statements[i]!.line}`).join(", ")}` });
    }
  }
  // same-signature function duplicates
  const sigSeen = new Map<string, Stmt>();
  for (const s of statements.filter((s) => s.kind === "function" || s.kind === "procedure")) {
    const prev = sigSeen.get(s.identity);
    if (prev) findings.push({ level: "error", code: "DUPLICATE", message: `${s.identity} is defined twice: ${prev.file}:${prev.line}, ${s.file}:${s.line}` });
    sigSeen.set(s.identity, s);
  }

  // requirements and edges
  const edges: [number, number][] = [];
  const edgeSet = new Set<string>();
  const addEdge = (from: number, to: number) => {
    if (from === to) return;
    const key = `${from}>${to}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push([from, to]);
    }
  };
  for (const s of statements) {
    const x = extracted[s.id]!;
    const self = new Set(x.self);
    const where = `${s.file}:${s.line}`;
    const req: string[] = [];
    for (const r of x.c.rels) {
      const name = r.startsWith("?") ? r.slice(1) : r;
      if (r.startsWith("?") && x.c.ctes.has(name)) continue; // CTE, not a relation
      if (self.has(name)) continue;
      req.push(`rel:${name}`);
    }
    for (const t of x.c.types) if (!self.has(t)) req.push(`type:${t}`);
    for (const f of x.c.funcs) req.push(`func:${f}`);
    for (const t of x.c.foreign) if (!self.has(t)) req.push(`uniq:${t}`);
    s.requires = [...new Set(req)].sort();
    for (const k of [...s.requires, ...x.softRequires]) {
      const ps = producers.get(k)?.filter((p) => p !== s.id) ?? [];
      if (ps.length === 0) {
        const [ns, name] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
        const builtin =
          (ns === "rel" && builtins.rels.has(name)) || (ns === "type" && builtins.types.has(name)) || (ns === "func" && builtins.funcs.has(name));
        const soft = ["uniq", "con", "trigger", "policy"].includes(ns) || (s.phase === 1 && ns === "rel");
        if (!builtin && !soft && !(producers.get(k)?.includes(s.id))) {
          findings.push({ level: "error", code: "UNRESOLVED", message: `${where}: ${s.identity} references ${ns === "rel" ? "relation" : ns === "func" ? "function" : "type"} "${name}", which no statement creates and pg_catalog does not have` });
        }
        continue;
      }
      if (k.startsWith("func:") && opts.overloadEdges === "one") {
        // ABLATION: wait for only one overload (alphabetically last identity)
        addEdge([...ps].sort((a, b) => cmpStr(statements[b]!.identity, statements[a]!.identity))[0]!, s.id);
      } else for (const p of ps) addEdge(p, s.id);
    }
  }

  // Lints: ambiguity that the static guard could refuse instead of ordering around it
  const funcProducers = [...producers].filter(([k]) => k.startsWith("func:"));
  for (const [k, ids] of funcProducers) {
    const name = k.slice(5);
    const users = statements.filter((s) => s.bindsAtCreate && s.requires.includes(k) && !ids.includes(s.id));
    if (ids.length > 1 && users.length)
      findings.push({ level: "lint", code: "OVERLOADED_REFERENCE", message: `${name} has ${ids.length} overloads (${ids.map((i) => statements[i]!.identity).join(", ")}) and is referenced at CREATE time by ${users.map((u) => `${u.identity} @${u.file}:${u.line}`).join(", ")}` });
    if (builtins.funcs.has(name))
      findings.push({ level: "lint", code: "SHADOWS_PG_CATALOG", message: `function ${name} also exists in pg_catalog; with search_path = managed, pg_catalog the user function can capture calls` });
  }
  for (const [k, ids] of producers) {
    const [ns, name] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const table = name.replace(/\(.*$/, "");
    if (ns === "uniqcols" && new Set(ids).size > 1 && statements.some((s) => s.requires.includes(`uniq:${table}`)))
      findings.push({ level: "lint", code: "FK_INDEX_CHOICE", message: `${name} has ${new Set(ids).size} unique indexes/constraints (${[...new Set(ids)].map((i) => statements[i]!.identity).join(", ")}) and is referenced by a foreign key: PostgreSQL binds the FK to whichever qualifying index it finds first` });
    if ((ns === "type" && builtins.types.has(name)) || (ns === "rel" && builtins.rels.has(name)))
      findings.push({ level: "lint", code: "SHADOWS_PG_CATALOG", message: `${ns} ${name} (${ids.map((i) => statements[i]!.identity).join(", ")}) shadows a pg_catalog name` });
  }
  return { statements, edges, findings };
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type TieBreak = "forward" | "reverse" | "reverse-ignore-priority" | { seed: number };

function keyCompare(mode: TieBreak, statements: Stmt[]): (a: Stmt, b: Stmt) => number {
  if (typeof mode === "object") {
    // seeded pseudo-random ranks: a valid order chosen without regard to content
    let x = mode.seed >>> 0 || 1;
    const rank = new Map<number, number>();
    for (const s of statements) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      rank.set(s.id, x);
    }
    return (a, b) => a.phase - b.phase || rank.get(a.id)! - rank.get(b.id)!;
  }
  const content = (a: Stmt, b: Stmt) => cmpStr(a.identity, b.identity) || cmpStr(a.hash, b.hash);
  // file/line only separates byte-identical duplicates, whose relative order cannot matter
  const last = (a: Stmt, b: Stmt) => cmpStr(a.file, b.file) || a.line - b.line;
  if (mode === "forward") return (a, b) => a.phase - b.phase || a.priority - b.priority || content(a, b) || last(a, b);
  if (mode === "reverse") return (a, b) => a.phase - b.phase || a.priority - b.priority || content(b, a) || last(b, a);
  return (a, b) => a.phase - b.phase || content(b, a) || last(b, a);
}

export interface Ordered {
  order: Stmt[];
  cycle?: Stmt[];
}

/** Kahn's algorithm; among ready statements always pick the smallest by the tie-break. */
export function order(a: Analysis, mode: TieBreak = "forward"): Ordered {
  const cmp = keyCompare(mode, a.statements);
  const indeg = new Map<number, number>(a.statements.map((s) => [s.id, 0]));
  const out = new Map<number, number[]>();
  for (const [f, t] of a.edges) {
    indeg.set(t, indeg.get(t)! + 1);
    out.set(f, [...(out.get(f) ?? []), t]);
  }
  const ready = a.statements.filter((s) => indeg.get(s.id) === 0);
  const result: Stmt[] = [];
  while (ready.length) {
    ready.sort(cmp);
    const s = ready.shift()!;
    result.push(s);
    for (const t of out.get(s.id) ?? []) {
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) ready.push(a.statements[t]!);
    }
  }
  if (result.length === a.statements.length) return { order: result };
  // find one cycle among the leftovers for the error message
  const left = new Set(a.statements.filter((s) => indeg.get(s.id)! > 0).map((s) => s.id));
  const preds = new Map<number, number[]>();
  for (const [f, t] of a.edges) if (left.has(f) && left.has(t)) preds.set(t, [...(preds.get(t) ?? []), f]);
  let cur = [...left].sort((x, y) => x - y)[0]!;
  const seen: number[] = [];
  while (!seen.includes(cur)) {
    seen.push(cur);
    cur = preds.get(cur)![0]!;
  }
  const cyc = seen.slice(seen.indexOf(cur)).reverse();
  return { order: result, cycle: cyc.map((i) => a.statements[i]!) };
}

export function cycleMessage(cycle: Stmt[], a: Analysis): string {
  const parts = cycle.map((s) => `${s.identity} (${s.file}:${s.line})`);
  const inlineFk = cycle.some((s) => s.kind === "table" && s.requires.some((r) => r.startsWith("uniq:")));
  const tip = inlineFk
    ? " Tip: move one foreign key out of CREATE TABLE into ALTER TABLE ... ADD CONSTRAINT."
    : " Tip: move the check/default that calls the function into ALTER TABLE ... ADD CONSTRAINT, or make the function PL/pgSQL (late-bound).";
  void a;
  return `dependency cycle: ${parts.join(" -> ")} -> ${parts[0]}.${tip}`;
}
