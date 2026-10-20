// An engine-independent picture of the managed schema, read straight from
// pg_catalog: one line per fact, named with pg_describe_object() so it never
// contains OIDs. Column order is left out. Besides the objects themselves it
// records what each object is bound to (pg_depend) and which index each
// foreign key uses, so a view bound to a different overload, or a different
// generated name, shows up as a difference.
import type { Session } from "../adapters/types.ts";

export interface CatalogFact {
  /** The object the fact is about, e.g. `view which_pick`, `column a of table t`. */
  readonly object: string;
  readonly detail: string;
}

const describe = (classTable: string, oid: string, sub = "0") =>
  `pg_describe_object('${classTable}'::regclass, ${oid}, ${sub})`;

/** Each query selects `object` and `detail`; `$1`, where used, is the managed schema's name. */
const queries: readonly string[] = [
  // Relations, with row-level security switches and options.
  `SELECT ${describe("pg_class", "c.oid")} AS object,
     'relation persistence=' || c.relpersistence::text || ' rls=' || c.relrowsecurity
       || ' force=' || c.relforcerowsecurity
       || ' options=' || coalesce(array_to_string(c.reloptions, ','), '-') AS detail
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'c', 'S', 'f', 'i', 'I')`,
  // Columns of tables, views and composite types.
  `SELECT ${describe("pg_class", "a.attrelid", "a.attnum")} AS object,
     'type=' || format_type(a.atttypid, a.atttypmod) || ' not_null=' || a.attnotnull
       || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text
       || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
       || ' collation=' || coalesce(nullif(a.attcollation, 0)::regcollation::text, '-') AS detail
   FROM pg_attribute a
   JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped
     AND c.relkind IN ('r', 'p', 'v', 'm', 'c', 'f')`,
  // Constraints on tables and domains, including the index a foreign key uses.
  `SELECT ${describe("pg_constraint", "k.oid")} AS object,
     k.contype::text || ' ' || pg_get_constraintdef(k.oid)
       || ' deferrable=' || k.condeferrable || ' deferred=' || k.condeferred
       || ' validated=' || k.convalidated || ' enforced=' || k.conenforced
       || ' no_inherit=' || k.connoinherit
       || ' index=' || coalesce(nullif(k.conindid, 0)::regclass::text, '-') AS detail
   FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
   WHERE n.nspname = $1`,
  `SELECT ${describe("pg_class", "i.indexrelid")} AS object,
     pg_get_indexdef(i.indexrelid) AS detail
   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1`,
  `SELECT ${describe("pg_class", "c.oid")} AS object,
     'query ' || pg_get_viewdef(c.oid) AS detail
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')`,
  `SELECT ${describe("pg_class", "s.seqrelid")} AS object,
     format_type(s.seqtypid, NULL) || ' start=' || s.seqstart || ' increment=' || s.seqincrement
       || ' min=' || s.seqmin || ' max=' || s.seqmax || ' cache=' || s.seqcache
       || ' cycle=' || s.seqcycle AS detail
   FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1`,
  `SELECT ${describe("pg_proc", "p.oid")} AS object,
     pg_get_functiondef(p.oid) AS detail
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')`,
  `SELECT ${describe("pg_trigger", "t.oid")} AS object,
     pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text AS detail
   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND NOT t.tgisinternal`,
  `SELECT ${describe("pg_type", "t.oid")} AS object,
     'type ' || t.typtype::text
       || ' base=' || coalesce(format_type(nullif(t.typbasetype, 0), t.typtypmod), '-')
       || ' not_null=' || t.typnotnull || ' default=' || coalesce(t.typdefault, '-')
       || ' array=' || coalesce(nullif(t.typarray, 0)::regtype::text, '-') AS detail
   FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = $1 AND t.typtype IN ('c', 'd') AND t.typelem = 0`,
  `SELECT ${describe("pg_policy", "p.oid")} AS object,
     'command=' || p.polcmd::text || ' permissive=' || p.polpermissive
       || ' roles=' || array(SELECT coalesce(r.rolname, 'public') FROM unnest(p.polroles) AS x
                             LEFT JOIN pg_roles r ON r.oid = x ORDER BY 1)::text
       || ' using=' || coalesce(pg_get_expr(p.polqual, p.polrelid), '-')
       || ' check=' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-') AS detail
   FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1`,
  // Comments on user objects and on the managed schema itself.
  `SELECT pg_describe_object(d.classoid, d.objoid, d.objsubid) AS object,
     'comment ' || d.description AS detail
   FROM pg_description d
   WHERE d.objoid >= 16384
      OR (d.classoid = 'pg_namespace'::regclass
          AND d.objoid = (SELECT oid FROM pg_namespace WHERE nspname = $1))`,
  // Privileges, sorted because ACL arrays keep grant order.
  `SELECT ${describe("pg_class", "c.oid")} AS object,
     'privileges ' || coalesce(array(SELECT x::text FROM unnest(c.relacl) AS x ORDER BY 1)::text, 'default') AS detail
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
   UNION ALL
   SELECT ${describe("pg_class", "a.attrelid", "a.attnum")},
     'privileges ' || array(SELECT x::text FROM unnest(a.attacl) AS x ORDER BY 1)::text
   FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND a.attacl IS NOT NULL
   UNION ALL
   SELECT ${describe("pg_proc", "p.oid")},
     'privileges ' || coalesce(array(SELECT x::text FROM unnest(p.proacl) AS x ORDER BY 1)::text, 'default')
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = $1
   UNION ALL
   SELECT ${describe("pg_type", "t.oid")},
     'privileges ' || coalesce(array(SELECT x::text FROM unnest(t.typacl) AS x ORDER BY 1)::text, 'default')
   FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = $1 AND t.typtype IN ('c', 'd') AND t.typelem = 0
   UNION ALL
   SELECT ${describe("pg_namespace", "n.oid")},
     'privileges ' || coalesce(array(SELECT x::text FROM unnest(n.nspacl) AS x ORDER BY 1)::text, 'default')
   FROM pg_namespace n WHERE n.nspname = $1`,
  // What each user object is bound to: the overload a view or default calls,
  // the table a function body reads, the type a column uses.
  `SELECT pg_describe_object(classid, objid, objsubid) AS object,
     'depends on ' || pg_describe_object(refclassid, refobjid, refobjsubid)
       || ' (' || deptype::text || ')' AS detail
   FROM pg_depend
   WHERE objid >= 16384 AND deptype IN ('n', 'a')
     AND pg_describe_object(classid, objid, objsubid) NOT LIKE '%pg_toast%'
     AND pg_describe_object(refclassid, refobjid, refobjsubid) NOT LIKE '%pg_toast%'`,
];

/** Every fact about the managed schema, sorted. */
export async function catalogSnapshot(
  session: Session,
  managedSchema: string,
): Promise<CatalogFact[]> {
  const facts: CatalogFact[] = [];
  for (const sql of queries) {
    const result = await session.query<CatalogFact>(
      sql,
      sql.includes("$1") ? [managedSchema] : [],
    );
    for (const row of result.rows) {
      facts.push({ object: viewName(row.object), detail: row.detail });
    }
  }
  return facts.sort(
    (a, b) => compare(a.object, b.object) || compare(a.detail, b.detail),
  );
}

export interface CatalogDifference {
  /** `-` only in the first snapshot, `+` only in the second. */
  readonly side: "-" | "+";
  readonly fact: CatalogFact;
}

/** Facts present in only one snapshot. */
export function catalogDifferences(
  first: readonly CatalogFact[],
  second: readonly CatalogFact[],
): CatalogDifference[] {
  const key = (fact: CatalogFact) => `${fact.object}\u0000${fact.detail}`;
  const inFirst = new Set(first.map(key));
  const inSecond = new Set(second.map(key));
  return [
    ...first
      .filter((fact) => !inSecond.has(key(fact)))
      .map((fact) => ({ side: "-" as const, fact })),
    ...second
      .filter((fact) => !inFirst.has(key(fact)))
      .map((fact) => ({ side: "+" as const, fact })),
  ].sort(
    (a, b) =>
      compare(a.fact.object, b.fact.object) ||
      compare(a.side, b.side) ||
      compare(a.fact.detail, b.fact.detail),
  );
}

/** A view's query is its `_RETURN` rule; name the view instead. */
function viewName(object: string): string {
  return object.replace(/^rule _RETURN on /, "");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
