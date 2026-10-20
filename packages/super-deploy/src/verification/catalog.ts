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
// Ownership is never compared: ACLs name the owner `<owner>` (so a target
// owned by its deploy role matches a replica owned by the rehearsal login).
//
// Binding facts (opt-in) record what each object is bound to: pg_depend
// edges (the overload a view or default calls, the table a function body
// reads) and the index each foreign key uses. The order-independence check
// (ADR-0004) compares them; rehearsals don't.
import { inTransaction } from "../adapters/transaction.ts";
import type { Session } from "../adapters/types.ts";
import { pinnedSettings } from "../rehearsal/throwaway.ts";
import { schemaSetupRoles } from "./schema-setup.ts";

const describe = (classTable: string, oid: string, sub = "0") =>
  `pg_describe_object('${classTable}'::regclass, ${oid}, ${sub})`;

/**
 * An ACL as a sorted list of `grantee:PRIVILEGE[*]/grantor` items, with the
 * object's owner written `<owner>` and PUBLIC `public`. Ownership is never
 * compared (REFINEMENTS "Roles, grants and ownership"): a target's objects
 * belong to its deploy role, a replica's to the rehearsal login.
 */
const privileges = (acl: string, owner: string) => `array(
      select case when e.grantee = 0 then 'public' when e.grantee = ${owner} then '<owner>' else quote_ident(pg_get_userbyid(e.grantee)) end
        || ':' || e.privilege_type || case when e.is_grantable then '*' else '' end
        || '/' || case when e.grantor = ${owner} then '<owner>' else quote_ident(pg_get_userbyid(e.grantor)) end
      from aclexplode(${acl}) e order by 1)::text`;

/**
 * The managed schema's own ACL, written like `privileges` but with the
 * session's role (the deploy role on a target) counted as the owner too
 * (schema-setup.ts): a rehearsal's schema belongs to the rehearsal login.
 * Every other grant on the schema is the desired schema's (stories 98-99),
 * so on a target it is drift. A target that doesn't have the schema
 * yet reads as the schema its first deployment creates.
 */
const schemaAcl = `
    select 'schema ' || quote_ident($1), 'schema ' || $1 || ' ' || array(
      select distinct case when e.grantee = 0 then 'public' when e.grantee = any(setup.roles) then '<owner>' else quote_ident(pg_get_userbyid(e.grantee)) end
        || ':' || e.privilege_type
        || case when e.is_grantable and e.grantee <> all(setup.roles) then '*' else '' end
        || '/' || case when e.grantor = any(setup.roles) then '<owner>' else quote_ident(pg_get_userbyid(e.grantor)) end
      from aclexplode(s.acl) e order by 1)::text
    from (select oid from pg_roles where rolname = current_user) me,
      lateral (select coalesce(
          (select coalesce(n.nspacl, acldefault('n'::"char", n.nspowner)) from pg_namespace n where n.nspname = $1),
          acldefault('n'::"char", me.oid)) as acl,
        coalesce((select n.nspowner from pg_namespace n where n.nspname = $1), me.oid) as owner) s,
      lateral (select array(${schemaSetupRoles("s.owner")}) as roles) setup`;

/** Each query selects `object` and `line`; `$1` is the managed schema. */
const queries: Readonly<Record<string, string>> = {
  relation: `
    select ${describe("pg_class", "c.oid")},
      c.relkind::text || ' ' || c.relname || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
      || ' persistence=' || c.relpersistence::text || ' options=' || coalesce(c.reloptions::text, '-')
      || ' am=' || coalesce(am.amname, '-') || ' replident=' || c.relreplident::text
      || ' inherits=' || array(select h.inhparent::regclass::text from pg_inherits h where h.inhrelid = c.oid order by h.inhseqno)::text
      || ' partkey=' || coalesce(case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end, '-')
      || ' bound=' || coalesce(pg_get_expr(c.relpartbound, c.oid), '-')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_am am on am.oid = c.relam
    where n.nspname = $1 and c.relkind in ('r','v','m','S','c','p','f')`,
  column: `
    select ${describe("pg_class", "a.attrelid", "a.attnum")},
      c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
      || ' notnull=' || a.attnotnull || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text
      || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
      || ' collation=' || coalesce(nullif(a.attcollation, 0)::regcollation::text, '-')
      || ' storage=' || a.attstorage::text || ' compression=' || coalesce(nullif(a.attcompression::text, ''), '-')
      || ' stattarget=' || coalesce(a.attstattarget::text, '-') || ' local=' || a.attislocal
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
      || ' valid=' || i.indisvalid || ' clustered=' || i.indisclustered || ' replident=' || i.indisreplident
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
      c.relname || ' ' || ${privileges(`coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))`, "c.relowner")}
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind not in ('i', 'I')
    union all
    select ${describe("pg_class", "a.attrelid", "a.attnum")},
      c.relname || '.' || a.attname || ' ' || ${privileges("a.attacl", "c.relowner")}
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and a.attacl is not null
    union all
    select ${describe("pg_proc", "p.oid")},
      p.oid::regprocedure::text || ' ' || ${privileges(`coalesce(p.proacl, acldefault('f'::"char", p.proowner))`, "p.proowner")}
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1
    union all
    select case when r.relkind is null or r.relkind = 'c' then ${describe("pg_type", "t.oid")} else ${describe("pg_class", "r.oid")} end,
      t.typname || ' ' || ${privileges(`coalesce(t.typacl, acldefault('T'::"char", t.typowner))`, "t.typowner")}
    from pg_type t join pg_namespace n on n.oid = t.typnamespace left join pg_class r on r.oid = t.typrelid
    where n.nspname = $1 and t.typtype in ('d','c')
    union all${schemaAcl}`,
  // Everything else a schema can hold. Desired schemas can't create these,
  // so rehearsals never have any; on a target they are drift.
  other: `
    select ${describe("pg_proc", "p.oid")}, p.prokind::text || ' ' || p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1 and p.prokind not in ('f','p')
    union all
    select ${describe("pg_type", "t.oid")}, t.typtype::text || ' ' || t.typname
    from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = $1 and t.typtype in ('b','p') and t.typelem = 0
    union all
    select ${describe("pg_rewrite", "r.oid")}, pg_get_ruledef(r.oid)
    from pg_rewrite r join pg_class c on c.oid = r.ev_class join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and r.rulename <> '_RETURN'
    union all
    select ${describe("pg_statistic_ext", "x.oid")}, pg_get_statisticsobjdef(x.oid)
    from pg_statistic_ext x join pg_namespace n on n.oid = x.stxnamespace where n.nspname = $1
    union all
    select ${describe("pg_extension", "e.oid")}, e.extname || ' ' || e.extversion
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace where n.nspname = $1
    union all
    select ${describe("pg_publication_rel", "pr.oid")}, ${describe("pg_publication_rel", "pr.oid")}
    from pg_publication_rel pr join pg_class c on c.oid = pr.prrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1
    union all
    select ${describe("pg_publication_namespace", "pn.oid")}, ${describe("pg_publication_namespace", "pn.oid")}
    from pg_publication_namespace pn join pg_namespace n on n.oid = pn.pnnspid where n.nspname = $1
    union all
    select pg_describe_object(o.class, o.obj, 0), pg_describe_object(o.class, o.obj, 0)
    from (select 'pg_operator'::regclass, oid, oprnamespace from pg_operator
          union all select 'pg_opclass'::regclass, oid, opcnamespace from pg_opclass
          union all select 'pg_opfamily'::regclass, oid, opfnamespace from pg_opfamily
          union all select 'pg_collation'::regclass, oid, collnamespace from pg_collation
          union all select 'pg_conversion'::regclass, oid, connamespace from pg_conversion
          union all select 'pg_ts_config'::regclass, oid, cfgnamespace from pg_ts_config
          union all select 'pg_ts_dict'::regclass, oid, dictnamespace from pg_ts_dict
          union all select 'pg_ts_parser'::regclass, oid, prsnamespace from pg_ts_parser
          union all select 'pg_ts_template'::regclass, oid, tmplnamespace from pg_ts_template) o(class, obj, ns)
    join pg_namespace n on n.oid = o.ns
    where n.nspname = $1`,
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
  const facts: CatalogFact[] = [];
  const all = options.bindings ? { ...queries, ...bindingQueries } : queries;
  await inTransaction(
    session,
    async () => {
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
    },
    [
      "BEGIN READ ONLY",
      ...readSettings(schema),
      ...(options.settings ?? []),
    ].join(";\n"),
  );
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
