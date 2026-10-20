// The engine-independent check: read the managed schema straight out of
// pg_catalog in two databases and compare. Independent of the differ, so it
// catches what pg-delta's own re-diff misses (prototype/pg-delta found lost
// PG18 NOT NULL constraint names, comments on constraint-backed indexes and
// STORED vs VIRTUAL generated columns).
//
// One query per object kind, each returning one text line per object with no
// OIDs (names, pg_get_*def, format_type), plus the object it describes
// (pg_describe_object, also OID-free) so differences can name objects.
// Column order (attnum) is never compared, and ACLs are normalised with
// acldefault() so implicit and explicit default grants compare equal.
// Ownership appears only through default ACLs, which is the same in both
// databases (one rehearsal login).
//
// Binding facts (opt-in) record what each object is bound to: pg_depend
// edges (the overload a view or default calls, the table a function body
// reads) and the index each foreign key uses. The order-independence check
// (ADR-0004) compares them; rehearsals don't.
import type { Session } from "../adapters/types.ts";

const describe = (classTable: string, oid: string, sub = "0") =>
  `pg_describe_object('${classTable}'::regclass, ${oid}, ${sub})`;

/** Each query selects `object` and `line`; `$1` is the managed schema. */
const queries: Readonly<Record<string, string>> = {
  relation: `
    select ${describe("pg_class", "c.oid")},
      c.relkind::text || ' ' || c.relname || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
      || ' persistence=' || c.relpersistence::text || ' options=' || coalesce(c.reloptions::text, '-')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relkind in ('r','v','m','S','c','p','f')`,
  column: `
    select ${describe("pg_class", "a.attrelid", "a.attnum")},
      c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
      || ' notnull=' || a.attnotnull || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text
      || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
      || ' collation=' || coalesce(nullif(a.attcollation, 0)::regcollation::text, '-')
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = $1 and a.attnum > 0 and not a.attisdropped and c.relkind in ('r','v','m','c','p','f')`,
  constraint: `
    select ${describe("pg_constraint", "k.oid")},
      coalesce(c.relname, t.typname) || ' ' || k.conname || ' ' || k.contype::text || ' ' || pg_get_constraintdef(k.oid)
      || ' deferrable=' || k.condeferrable || ' deferred=' || k.condeferred || ' validated=' || k.convalidated
    from pg_constraint k join pg_namespace n on n.oid = k.connamespace
    left join pg_class c on c.oid = k.conrelid left join pg_type t on t.oid = k.contypid
    where n.nspname = $1`,
  index: `
    select ${describe("pg_class", "i.indexrelid")}, pg_get_indexdef(i.indexrelid)
    from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1`,
  view: `
    select ${describe("pg_class", "c.oid")}, c.relkind::text || ' ' || c.relname || ' ' || pg_get_viewdef(c.oid, true)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relkind in ('v','m')`,
  sequence: `
    select ${describe("pg_class", "s.seqrelid")},
      c.relname || ' ' || format_type(s.seqtypid, null) || ' start=' || s.seqstart || ' inc=' || s.seqincrement
      || ' min=' || s.seqmin || ' max=' || s.seqmax || ' cache=' || s.seqcache || ' cycle=' || s.seqcycle
    from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1`,
  routine: `
    select ${describe("pg_proc", "p.oid")}, pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = $1 and p.prokind in ('f','p')`,
  trigger: `
    select ${describe("pg_trigger", "t.oid")}, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and not t.tgisinternal`,
  type: `
    select ${describe("pg_type", "t.oid")},
      t.typtype::text || ' ' || t.typname || ' base=' || coalesce(format_type(t.typbasetype, t.typtypmod), '-')
      || ' notnull=' || t.typnotnull || ' default=' || coalesce(t.typdefault, '-')
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = $1 and t.typtype in ('d','c','e','r')
      and not exists (select 1 from pg_class c where c.reltype = t.oid and c.relkind <> 'c')`,
  policy: `
    select ${describe("pg_policy", "p.oid")},
      c.relname || ' ' || p.polname || ' cmd=' || p.polcmd::text || ' permissive=' || p.polpermissive
      || ' roles=' || array(select coalesce(r.rolname, 'public') from unnest(p.polroles) x left join pg_roles r on r.oid = x order by 1)::text
      || ' using=' || coalesce(pg_get_expr(p.polqual, p.polrelid), '-')
      || ' check=' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-')
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1`,
  comment: `
    select pg_describe_object(d.classoid, d.objoid, d.objsubid),
      d.classoid::regclass || ' ' || coalesce(
             (select relname from pg_class where oid = d.objoid and d.classoid = 'pg_class'::regclass),
             (select proname from pg_proc where oid = d.objoid and d.classoid = 'pg_proc'::regclass),
             (select conname from pg_constraint where oid = d.objoid and d.classoid = 'pg_constraint'::regclass),
             (select typname from pg_type where oid = d.objoid and d.classoid = 'pg_type'::regclass),
             (select tgname from pg_trigger where oid = d.objoid and d.classoid = 'pg_trigger'::regclass),
             (select polname from pg_policy where oid = d.objoid and d.classoid = 'pg_policy'::regclass),
             d.objoid::text)
           || ' sub=' || d.objsubid || ' ' || d.description
    from pg_description d
    where d.classoid in ('pg_class'::regclass, 'pg_proc'::regclass, 'pg_constraint'::regclass,
                         'pg_type'::regclass, 'pg_trigger'::regclass, 'pg_policy'::regclass)
      and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = d.objoid and n.nspname = $1
                  union all select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = d.objoid and n.nspname = $1
                  union all select 1 from pg_constraint k join pg_namespace n on n.oid = k.connamespace where k.oid = d.objoid and n.nspname = $1
                  union all select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.oid = d.objoid and n.nspname = $1
                  union all select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace where g.oid = d.objoid and n.nspname = $1
                  union all select 1 from pg_policy o join pg_class c on c.oid = o.polrelid join pg_namespace n on n.oid = c.relnamespace where o.oid = d.objoid and n.nspname = $1)`,
  acl: `
    select ${describe("pg_class", "c.oid")},
      c.relname || ' ' || array(select x::text from unnest(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) x order by 1)::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1
    union all
    select ${describe("pg_class", "a.attrelid", "a.attnum")},
      c.relname || '.' || a.attname || ' ' || array(select x::text from unnest(a.attacl) x order by 1)::text
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and a.attacl is not null
    union all
    select ${describe("pg_proc", "p.oid")},
      p.oid::regprocedure::text || ' ' || array(select x::text from unnest(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) x order by 1)::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1
    union all
    select ${describe("pg_type", "t.oid")},
      t.typname || ' ' || array(select x::text from unnest(coalesce(t.typacl, acldefault('T'::"char", t.typowner))) x order by 1)::text
    from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = $1 and t.typtype in ('d','c')`,
};

const bindingQueries: Readonly<Record<string, string>> = {
  // User objects only (OIDs from FirstNormalObjectId); a rehearsal database holds nothing else.
  depends: `
    select pg_describe_object(classid, objid, objsubid),
      pg_describe_object(classid, objid, objsubid) || ' -> ' || pg_describe_object(refclassid, refobjid, refobjsubid)
      || ' [' || deptype::text || ']'
    from pg_depend
    where objid >= 16384 and deptype in ('n', 'a') and $1::text is not null
      and pg_describe_object(classid, objid, objsubid) not like '%pg_toast%'
      and pg_describe_object(refclassid, refobjid, refobjsubid) not like '%pg_toast%'`,
  foreignKeyIndex: `
    select ${describe("pg_constraint", "k.oid")},
      k.conrelid::regclass::text || '.' || k.conname || ' uses index ' || k.conindid::regclass::text
    from pg_constraint k join pg_namespace n on n.oid = k.connamespace
    where n.nspname = $1 and k.contype = 'f'`,
};

export interface CatalogFact {
  /** e.g. `relation`, `column`, `depends`. */
  readonly kind: string;
  /** The object described, e.g. `view which_pick`, `column a of table t`. */
  readonly object: string;
  /** The line compared, without the kind. */
  readonly line: string;
}

export interface CatalogFactOptions {
  /** Also record pg_depend bindings and each foreign key's index. */
  readonly bindings?: boolean;
}

/** Every fact about `schema`, sorted by `kind: line`. */
export async function catalogFacts(
  session: Session,
  schema: string,
  options: CatalogFactOptions = {},
): Promise<CatalogFact[]> {
  const facts: CatalogFact[] = [];
  const all = options.bindings ? { ...queries, ...bindingQueries } : queries;
  for (const [kind, sql] of Object.entries(all)) {
    const result = await session.query<{ object: string; line: string }>(
      `select object, line from (${sql}) as snapshot(object, line)`,
      [schema],
    );
    for (const row of result.rows) {
      // A view's query is its _RETURN rule; name the view instead.
      const object = row.object.replace(/^rule _RETURN on /, "");
      facts.push({ kind, object, line: row.line });
    }
  }
  return facts.sort((a, b) => compare(factLine(a), factLine(b)));
}

/** `kind: line`, the form snapshots and differences use. */
export function factLine(fact: CatalogFact): string {
  return `${fact.kind}: ${fact.line}`;
}

/** One sorted line per object in `schema`, each prefixed with its kind. */
export async function catalogSnapshot(
  session: Session,
  schema: string,
): Promise<string[]> {
  return (await catalogFacts(session, schema)).map(factLine);
}

/** Facts on only one side: `-` only in `actual`, `+` only in `expected`. */
export function factDifferences(
  actual: readonly CatalogFact[],
  expected: readonly CatalogFact[],
): { side: "-" | "+"; fact: CatalogFact }[] {
  const inActual = new Set(actual.map(factLine));
  const inExpected = new Set(expected.map(factLine));
  return [
    ...actual
      .filter((fact) => !inExpected.has(factLine(fact)))
      .map((fact) => ({ side: "-" as const, fact })),
    ...expected
      .filter((fact) => !inActual.has(factLine(fact)))
      .map((fact) => ({ side: "+" as const, fact })),
  ];
}

/**
 * Lines present on only one side: `- <line>` only in `actual`, `+ <line>`
 * only in `expected`. Empty when the managed schemas match.
 */
export async function catalogDifferences(
  actual: Session,
  expected: Session,
  schema: string,
): Promise<string[]> {
  return factDifferences(
    await catalogFacts(actual, schema),
    await catalogFacts(expected, schema),
  ).map(({ side, fact }) => `${side} ${factLine(fact)}`);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
