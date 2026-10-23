// The engine-independent check: read the managed schema straight out of
// pg_catalog in two databases and compare. Independent of the differ, so it
// catches what pg-delta's own re-diff misses (prototype/pg-delta found lost
// PG18 NOT NULL constraint names, comments on constraint-backed indexes and
// STORED vs VIRTUAL generated columns).
//
// One query per object kind, each returning one text line per object with no
// OIDs (names, pg_get_*def, format_type), plus the object it describes
// so differences can name objects. The description (pg_describe_object, also
// OID-free, but naming domains and composite types as `objectName` says) is
// read last, with only pg_catalog on the search path, so names
// in the managed schema carry their schema (`index app.orders_idx`), quoted
// once where they need quotes; the lines keep the pinned search path.
// Column order (attnum) is never compared, except for composite types:
// their values are built by position (ROW(...), '(a,b)'), so an attribute's
// position among the live ones is part of the type (pg-delta doesn't diff
// it). So a column's comment names the column, never its attnum (objsubid).
// Ownership, grants (ACLs on objects, columns and the managed schema),
// policies and row-level security flags are never read: they are set up on
// targets outside super-deploy (ADR-0006), so they are never drift and a
// rehearsal never compares them. A comment on a policy goes with its policy.
//
// A target older than 18 (postgresVersion's escape hatch, ADR-0007) reads as
// 18 would in the two ways adoption needs: a default statistics target is
// `-1` before 17 (NULL since), and before 18 a NOT NULL column has no
// `<table>_<column>_not_null` constraint, so one is read for each.
//
// Binding facts (opt-in) record what each object is bound to: pg_depend
// edges (the overload a view or default calls, the table a function body
// reads) and the index each foreign key uses. The order-independence check
// (ADR-0004) compares them; rehearsals don't.
import { inTransaction } from "../adapters/transaction.ts";
import type { Session } from "../adapters/types.ts";
import { pinnedSettings } from "../rehearsal/throwaway.ts";
import { generatedName } from "../sql-analysis/generated-names.ts";
import type { CatalogReference } from "../sql-analysis/index.ts";

const describe = (classTable: string, oid: string, sub = "0") =>
  `pg_describe_object('${classTable}'::regclass, ${oid}, ${sub})`;

/** The columns that locate an object in its database: class, object, sub-object. */
const address = (classTable: string, oid: string, sub = "0") =>
  `'${classTable}'::regclass, ${oid}, ${sub}`;

/**
 * Each query selects the object it describes (its class, object and
 * sub-object ids, as for pg_describe_object) and `line`; `$1` is the managed
 * schema.
 */
const queries: Readonly<Record<string, string>> = {
  relation: `
    select ${address("pg_class", "c.oid")},
      c.relkind::text || ' ' || c.relname || ' persistence=' || c.relpersistence::text || ' options=' || coalesce(c.reloptions::text, '-')
      || ' am=' || coalesce(am.amname, '-') || ' replident=' || c.relreplident::text
      || ' inherits=' || array(select h.inhparent::regclass::text from pg_inherits h where h.inhrelid = c.oid order by h.inhseqno)::text
      || ' partkey=' || coalesce(case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end, '-')
      || ' bound=' || coalesce(pg_get_expr(c.relpartbound, c.oid), '-')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_am am on am.oid = c.relam
    where n.nspname = $1 and c.relkind in ('r','v','m','S','c','p','f')`,
  column: `
    select ${address("pg_class", "a.attrelid", "a.attnum")},
      c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
      || ' notnull=' || a.attnotnull || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text
      || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
      || ' collation=' || coalesce(nullif(a.attcollation, 0)::regcollation::text, '-')
      || ' storage=' || a.attstorage::text || ' compression=' || coalesce(nullif(a.attcompression::text, ''), '-')
      || ' stattarget=' || coalesce(nullif(a.attstattarget, -1)::text, '-') || ' local=' || a.attislocal
      || case when c.relkind = 'c' then ' position=' || row_number() over (partition by a.attrelid order by a.attnum) else '' end
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = $1 and a.attnum > 0 and not a.attisdropped and c.relkind in ('r','v','m','c','p','f')`,
  constraint: `
    select ${address("pg_constraint", "k.oid")},
      coalesce(c.relname, t.typname) || ' ' || k.conname || ' ' || k.contype::text || ' ' || pg_get_constraintdef(k.oid)
      || ' deferrable=' || k.condeferrable || ' deferred=' || k.condeferred || ' validated=' || k.convalidated
    from pg_constraint k join pg_namespace n on n.oid = k.connamespace
    left join pg_class c on c.oid = k.conrelid left join pg_type t on t.oid = k.contypid
    where n.nspname = $1`,
  index: `
    select ${address("pg_class", "i.indexrelid")}, pg_get_indexdef(i.indexrelid)
      || ' valid=' || i.indisvalid || ' clustered=' || i.indisclustered || ' replident=' || i.indisreplident
    from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1`,
  view: `
    select ${address("pg_class", "c.oid")}, c.relkind::text || ' ' || c.relname || ' ' || pg_get_viewdef(c.oid, true)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relkind in ('v','m')`,
  sequence: `
    select ${address("pg_class", "s.seqrelid")},
      c.relname || ' ' || format_type(s.seqtypid, null) || ' start=' || s.seqstart || ' inc=' || s.seqincrement
      || ' min=' || s.seqmin || ' max=' || s.seqmax || ' cache=' || s.seqcache || ' cycle=' || s.seqcycle
    from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1`,
  routine: `
    select ${address("pg_proc", "p.oid")}, pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = $1 and p.prokind in ('f','p')`,
  trigger: `
    select ${address("pg_trigger", "t.oid")}, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and not t.tgisinternal`,
  type: `
    select ${address("pg_type", "t.oid")},
      t.typtype::text || ' ' || t.typname || ' base=' || coalesce(format_type(t.typbasetype, t.typtypmod), '-')
      || ' notnull=' || t.typnotnull || ' default=' || coalesce(t.typdefault, '-')
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = $1 and t.typtype in ('d','c','e','r')
      and not exists (select 1 from pg_class c where c.reltype = t.oid and c.relkind <> 'c')`,
  comment: `
    select d.classoid, d.objoid, d.objsubid,
      d.classoid::regclass || ' ' || coalesce(
             (select relname from pg_class where oid = d.objoid and d.classoid = 'pg_class'::regclass),
             (select proname from pg_proc where oid = d.objoid and d.classoid = 'pg_proc'::regclass),
             (select conname from pg_constraint where oid = d.objoid and d.classoid = 'pg_constraint'::regclass),
             (select typname from pg_type where oid = d.objoid and d.classoid = 'pg_type'::regclass),
             (select tgname from pg_trigger where oid = d.objoid and d.classoid = 'pg_trigger'::regclass),
             d.objoid::text)
           || coalesce((select '.' || attname from pg_attribute
                        where attrelid = d.objoid and attnum = d.objsubid and d.classoid = 'pg_class'::regclass), '')
           || ' ' || d.description
    from pg_description d
    where d.classoid in ('pg_class'::regclass, 'pg_proc'::regclass, 'pg_constraint'::regclass,
                         'pg_type'::regclass, 'pg_trigger'::regclass)
      and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = d.objoid and n.nspname = $1
                  union all select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = d.objoid and n.nspname = $1
                  union all select 1 from pg_constraint k join pg_namespace n on n.oid = k.connamespace where k.oid = d.objoid and n.nspname = $1
                  union all select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.oid = d.objoid and n.nspname = $1
                  union all select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace where g.oid = d.objoid and n.nspname = $1)`,
  // Everything else a schema can hold. Desired schemas can't create these,
  // so rehearsals never have any; on a target they are drift. Members of an
  // extension in the schema (pg_depend deptype 'e': its functions, types,
  // operators...) go with their extension: only it is listed.
  other: `
    select o.class, o.obj, 0, o.line
    from (
      select 'pg_proc'::regclass, p.oid, p.prokind::text || ' ' || p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1 and p.prokind not in ('f','p')
      union all
      select 'pg_type'::regclass, t.oid, t.typtype::text || ' ' || t.typname
      from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = $1 and t.typtype in ('b','p') and t.typelem = 0
      union all
      select 'pg_rewrite'::regclass, r.oid, pg_get_ruledef(r.oid)
      from pg_rewrite r join pg_class c on c.oid = r.ev_class join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and r.rulename <> '_RETURN'
      union all
      select 'pg_statistic_ext'::regclass, x.oid, pg_get_statisticsobjdef(x.oid)
      from pg_statistic_ext x join pg_namespace n on n.oid = x.stxnamespace where n.nspname = $1
      union all
      select 'pg_extension'::regclass, e.oid, e.extname || ' ' || e.extversion
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace where n.nspname = $1
      union all
      select 'pg_publication_rel'::regclass, pr.oid, ${describe("pg_publication_rel", "pr.oid")}
      from pg_publication_rel pr join pg_class c on c.oid = pr.prrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1
      union all
      select 'pg_publication_namespace'::regclass, pn.oid, ${describe("pg_publication_namespace", "pn.oid")}
      from pg_publication_namespace pn join pg_namespace n on n.oid = pn.pnnspid where n.nspname = $1
      union all
      select m.class, m.obj, pg_describe_object(m.class, m.obj, 0)
      from (select 'pg_operator'::regclass, oid, oprnamespace from pg_operator
            union all select 'pg_opclass'::regclass, oid, opcnamespace from pg_opclass
            union all select 'pg_opfamily'::regclass, oid, opfnamespace from pg_opfamily
            union all select 'pg_collation'::regclass, oid, collnamespace from pg_collation
            union all select 'pg_conversion'::regclass, oid, connamespace from pg_conversion
            union all select 'pg_ts_config'::regclass, oid, cfgnamespace from pg_ts_config
            union all select 'pg_ts_dict'::regclass, oid, dictnamespace from pg_ts_dict
            union all select 'pg_ts_parser'::regclass, oid, prsnamespace from pg_ts_parser
            union all select 'pg_ts_template'::regclass, oid, tmplnamespace from pg_ts_template) m(class, obj, ns)
      join pg_namespace n on n.oid = m.ns
      where n.nspname = $1
    ) o(class, obj, line)
    where not exists (
      select 1 from pg_depend d
      join pg_extension e on e.oid = d.refobjid
      join pg_namespace n on n.oid = e.extnamespace
      where d.classid = o.class and d.objid = o.obj and d.deptype = 'e'
        and d.refclassid = 'pg_extension'::regclass and n.nspname = $1)`,
};

const bindingQueries: Readonly<Record<string, string>> = {
  // User objects only (OIDs from FirstNormalObjectId); a rehearsal database holds nothing else.
  depends: `
    select classid, objid, objsubid,
      pg_describe_object(classid, objid, objsubid) || ' -> ' || pg_describe_object(refclassid, refobjid, refobjsubid)
      || ' [' || deptype::text || ']'
    from pg_depend
    where objid >= 16384 and deptype in ('n', 'a') and $1::text is not null
      and pg_describe_object(classid, objid, objsubid) not like '%pg_toast%'
      and pg_describe_object(refclassid, refobjid, refobjsubid) not like '%pg_toast%'`,
  foreignKeyIndex: `
    select ${address("pg_constraint", "k.oid")},
      k.conrelid::regclass::text || '.' || k.conname || ' uses index ' || k.conindid::regclass::text
    from pg_constraint k join pg_namespace n on n.oid = k.connamespace
    where n.nspname = $1 and k.contype = 'f'`,
};

/**
 * Before PostgreSQL 18: each table's NOT NULL columns, as the table (its
 * address) and the column, for the constraints 18 would record.
 */
const notNullColumns = `
  select ${address("pg_class", "c.oid")}, c.relname, a.attname, quote_ident(a.attname) as quoted
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1 and a.attnum > 0 and not a.attisdropped and a.attnotnull and c.relkind in ('r','p')`;

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
  /**
   * More `SET LOCAL` statements for the read-only transaction the catalogs
   * are read in, e.g. a target's lock and statement timeouts.
   */
  readonly settings?: readonly string[];
}

/**
 * Settings that change how definitions are printed (name qualification,
 * constants in defaults), pinned so two servers' defaults never differ.
 */
function readSettings(schema: string): string[] {
  return [
    ...pinnedSettings(schema),
    "SET LOCAL extra_float_digits TO 1",
    "SET LOCAL bytea_output TO 'hex'",
  ];
}

/** Every fact about `schema`, sorted by `kind: line`. */
export async function catalogFacts(
  session: Session,
  schema: string,
  options: CatalogFactOptions = {},
): Promise<CatalogFact[]> {
  const read: {
    kind: string;
    key: string;
    line: string;
    /** For a NOT NULL constraint read before 18: its name; `key` is its table's. */
    notNull?: string;
  }[] = [];
  const objects = new Map<string, string>();
  const all = options.bindings ? { ...queries, ...bindingQueries } : queries;
  await inTransaction(
    session,
    async () => {
      for (const [kind, sql] of Object.entries(all)) {
        const result = await session.query<ObjectAddress & { line: string }>(
          `select class::oid::text as class, obj::oid::text as obj, sub::int4 as sub, line
           from (${sql}) as snapshot(class, obj, sub, line)`,
          [schema],
        );
        for (const row of result.rows) {
          read.push({ kind, key: addressKey(row), line: row.line });
        }
      }
      const version = await session.query<{ version: number }>(
        "select current_setting('server_version_num')::int as version",
      );
      if ((version.rows[0]?.version ?? 0) < 180000) {
        const columns = await session.query<
          ObjectAddress & { relname: string; attname: string; quoted: string }
        >(
          `select class::oid::text as class, obj::oid::text as obj, sub::int4 as sub, relname, attname, quoted
           from (${notNullColumns}) as columns(class, obj, sub, relname, attname, quoted)`,
          [schema],
        );
        for (const row of columns.rows) {
          const name = generatedName(row.relname, row.attname, "not_null");
          read.push({
            kind: "constraint",
            key: addressKey(row),
            line: `${row.relname} ${name} n NOT NULL ${row.quoted} deferrable=false deferred=false validated=true`,
            notNull: name,
          });
        }
      }
      for (const [key, object] of await describeObjects(
        session,
        read.map(({ key }) => key),
      )) {
        objects.set(key, object);
      }
    },
    [
      "BEGIN READ ONLY",
      ...readSettings(schema),
      ...(options.settings ?? []),
    ].join(";\n"),
  );
  const facts = read.map(({ kind, key, line, notNull }) => {
    const object = objects.get(key) ?? key;
    return {
      kind,
      object:
        notNull === undefined ? object : `constraint ${notNull} on ${object}`,
      line,
    };
  });
  return facts.sort((a, b) => compare(factLine(a), factLine(b)));
}

/**
 * Each object's name, as the catalog facts name objects: pg_describe_object
 * with only pg_catalog on the search path, so `table app.orders`,
 * `function app.answer(integer)`. Read-only, in a transaction of its own.
 */
export async function objectNames(
  session: Session,
  addresses: readonly ObjectAddress[],
): Promise<string[]> {
  const keys = addresses.map(addressKey);
  const names = await inTransaction(
    session,
    () => describeObjects(session, keys),
    "BEGIN READ ONLY",
  );
  return keys.map((key) => names.get(key) ?? key);
}

/**
 * The name (as `objectNames` gives it) of each object `references` find by
 * name, or undefined for one the database doesn't have. Names resolve with
 * `managedSchema` and pg_catalog on the search path. Read-only, in a
 * transaction of its own.
 */
export async function referencedObjectNames(
  session: Session,
  managedSchema: string,
  references: readonly CatalogReference[],
): Promise<(string | undefined)[]> {
  return inTransaction(
    session,
    async () => {
      const { rows } = await session.query<{ ord: number } & ObjectAddress>(
        `select r.ord::int4 as ord, x.class::oid::text as class, x.obj::oid::text as obj, 0 as sub
         from unnest($1::text[], $2::text[], $3::text[]) with ordinality as r(kind, name, member, ord)
         cross join lateral (
           select 'pg_class'::regclass as class, to_regclass(r.name)::oid as obj where r.kind = 'relation'
           union all
           select 'pg_type'::regclass, to_regtype(r.name)::oid where r.kind = 'type'
           union all
           select 'pg_proc'::regclass, to_regprocedure(r.name)::oid where r.kind = 'routine'
           union all
           select 'pg_trigger'::regclass, t.oid from pg_trigger t
            where r.kind = 'trigger' and t.tgrelid = to_regclass(r.name) and t.tgname = r.member
           union all
           select 'pg_constraint'::regclass, c.oid from pg_constraint c
            where r.kind = 'constraint' and c.conrelid = to_regclass(r.name) and c.conname = r.member
         ) as x
         where x.obj is not null`,
        [
          references.map(({ kind }) => kind),
          references.map(({ name }) => name),
          references.map(({ member }) => member ?? null),
        ],
      );
      const names = await describeObjects(session, rows.map(addressKey));
      const byOrdinal = new Map(
        rows.map((row) => [row.ord, names.get(addressKey(row))]),
      );
      return references.map((_, index) => byOrdinal.get(index + 1));
    },
    ["BEGIN READ ONLY", ...pinnedSettings(managedSchema)].join(";\n"),
  );
}

/**
 * An object's name in drift, from `describeObjects`' address, `k` (its
 * pg_constraint row) and `t` (its pg_type row): pg_describe_object's, except
 * where that name hides what the object belongs to. A domain is `domain
 * app.d` and its constraint `constraint c on domain app.d` (PostgreSQL says
 * `type app.d` and `constraint c`), so an extra or missing domain folds its
 * constraints in as a table does (drift.ts); a composite type's pg_type row
 * takes its relation's name, `composite type app.pair`, so the type is one
 * object, not also `type app.pair`.
 */
const objectName = `case
  when k.contypid <> 0 then format('constraint %s on domain %s', k.conname, k.contypid::regtype)
  when t.typtype = 'd' then format('domain %s', t.oid::regtype)
  when t.typrelid <> 0 then pg_describe_object('pg_class'::regclass, t.typrelid, 0)
  else pg_describe_object(class, obj, sub) end`;

/**
 * Each address key's object description, in the transaction the session is
 * in. Described with the managed schema off the search path, so each
 * object in it is named with its schema: pg_describe_object leaves out the
 * schema of whatever the search path finds.
 */
async function describeObjects(
  session: Session,
  keys: readonly string[],
): Promise<Map<string, string>> {
  await session.execute("SET LOCAL search_path TO pg_catalog");
  const described = await session.query<ObjectAddress & { object: string }>(
    `select class::text as class, obj::text as obj, sub, ${objectName} as object
     from unnest($1::oid[], $2::oid[], $3::int4[]) as address(class, obj, sub)
     left join pg_constraint k on class = 'pg_constraint'::regclass and k.oid = obj
     left join pg_type t on class = 'pg_type'::regclass and t.oid = obj`,
    addressColumns([...new Set(keys)]),
  );
  // A view's query is its _RETURN rule; name the view instead.
  return new Map(
    described.rows.map((row) => [
      addressKey(row),
      row.object.replace(/^rule _RETURN on /, ""),
    ]),
  );
}

/** Where an object is in its database, as for pg_describe_object: oids as text. */
export interface ObjectAddress {
  readonly class: string;
  readonly obj: string;
  readonly sub: number;
}

function addressKey(address: ObjectAddress): string {
  return `${address.class}/${address.obj}/${address.sub}`;
}

/** The three `unnest` arrays (classes, objects, sub-objects) for `keys`. */
function addressColumns(keys: readonly string[]): string[][] {
  const parts = keys.map((key) => key.split("/"));
  return [0, 1, 2].map((column) => parts.map((part) => part[column] ?? ""));
}

/** `kind: line`, the form snapshots and differences use. */
export function factLine(fact: CatalogFact): string {
  return `${fact.kind}: ${fact.line}`;
}

/**
 * A column the target generates without storing (`attgenerated = 'v'`).
 * pg-delta renders every generated column STORED, so only this fact tells
 * a virtual one apart (adopt refuses it, as the rules do). Reads the
 * `column` query's `generated=` field, which ` default=` always follows.
 */
export function isVirtualGeneratedColumn(fact: CatalogFact): boolean {
  return fact.kind === "column" && fact.line.includes(" generated=v default=");
}

/** One sorted line per object in `schema`, each prefixed with its kind. */
export async function catalogSnapshot(
  session: Session,
  schema: string,
): Promise<string[]> {
  return (await catalogFacts(session, schema)).map(factLine);
}

/** A fact found on only one side of a comparison. */
export interface FactDifference {
  readonly side: "actual" | "expected";
  readonly fact: CatalogFact;
}

/** Facts on only one side, those only in `actual` first. */
export function factDifferences(
  actual: readonly CatalogFact[],
  expected: readonly CatalogFact[],
): FactDifference[] {
  const inActual = new Set(actual.map(factLine));
  const inExpected = new Set(expected.map(factLine));
  return [
    ...actual
      .filter((fact) => !inExpected.has(factLine(fact)))
      .map((fact) => ({ side: "actual" as const, fact })),
    ...expected
      .filter((fact) => !inActual.has(factLine(fact)))
      .map((fact) => ({ side: "expected" as const, fact })),
  ];
}

/**
 * The facts about `schema` present in only one of two databases. Empty when
 * the managed schemas match.
 */
export async function catalogDifferences(
  actual: Session,
  expected: Session,
  schema: string,
): Promise<FactDifference[]> {
  return factDifferences(
    await catalogFacts(actual, schema),
    await catalogFacts(expected, schema),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
