// THROWAWAY spike (issue 01). An engine-independent cross-check: read the
// managed schema straight out of pg_catalog and compare two databases. Column
// order (attnum) is deliberately left out. Used to catch things pg-delta's own
// fact model might not see (e.g. STORED vs VIRTUAL generated columns).
import type pg from "pg";

const QUERIES: Record<string, string> = {
  relation: `
    select c.relkind::text || ' ' || c.relname || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','v','m','S','c','p','f')`,
  column: `
    select c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
      || ' notnull=' || a.attnotnull || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text
      || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
      || ' collation=' || coalesce(nullif(a.attcollation, 0)::regcollation::text, '-')
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped and c.relkind in ('r','v','m','c','p','f')`,
  constraint: `
    select coalesce(c.relname, t.typname) || ' ' || k.conname || ' ' || k.contype::text || ' ' || pg_get_constraintdef(k.oid)
      || ' deferrable=' || k.condeferrable || ' deferred=' || k.condeferred || ' validated=' || k.convalidated
    from pg_constraint k join pg_namespace n on n.oid = k.connamespace
    left join pg_class c on c.oid = k.conrelid left join pg_type t on t.oid = k.contypid
    where n.nspname = 'public'`,
  index: `
    select pg_get_indexdef(i.indexrelid)
    from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'`,
  view: `
    select c.relkind::text || ' ' || c.relname || ' ' || pg_get_viewdef(c.oid, true)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v','m')`,
  sequence: `
    select c.relname || ' ' || format_type(s.seqtypid, null) || ' start=' || s.seqstart || ' inc=' || s.seqincrement
      || ' min=' || s.seqmin || ' max=' || s.seqmax || ' cache=' || s.seqcache || ' cycle=' || s.seqcycle
    from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'`,
  routine: `
    select pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f','p')`,
  trigger: `
    select pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal`,
  type: `
    select t.typtype::text || ' ' || t.typname || ' base=' || coalesce(format_type(t.typbasetype, t.typtypmod), '-')
      || ' notnull=' || t.typnotnull || ' default=' || coalesce(t.typdefault, '-')
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype in ('d','c','e','r')
      and not exists (select 1 from pg_class c where c.reltype = t.oid and c.relkind <> 'c')`,
  policy: `
    select c.relname || ' ' || p.polname || ' cmd=' || p.polcmd::text || ' permissive=' || p.polpermissive
      || ' roles=' || array(select coalesce(r.rolname, 'public') from unnest(p.polroles) x left join pg_roles r on r.oid = x order by 1)::text
      || ' using=' || coalesce(pg_get_expr(p.polqual, p.polrelid), '-')
      || ' check=' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-')
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'`,
  comment: `
    select d.classoid::regclass || ' ' || coalesce(
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
      and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = d.objoid and n.nspname = 'public'
                  union all select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = d.objoid and n.nspname = 'public'
                  union all select 1 from pg_constraint k join pg_namespace n on n.oid = k.connamespace where k.oid = d.objoid and n.nspname = 'public'
                  union all select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.oid = d.objoid and n.nspname = 'public'
                  union all select 1 from pg_trigger g where g.oid = d.objoid
                  union all select 1 from pg_policy o where o.oid = d.objoid)`,
  acl: `
    select c.relname || ' ' || array(select x::text from unnest(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) x order by 1)::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
    union all
    select c.relname || '.' || a.attname || ' ' || array(select x::text from unnest(a.attacl) x order by 1)::text
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and a.attacl is not null
    union all
    select p.oid::regprocedure::text || ' ' || array(select x::text from unnest(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) x order by 1)::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    union all
    select t.typname || ' ' || array(select x::text from unnest(coalesce(t.typacl, acldefault('T'::"char", t.typowner))) x order by 1)::text
    from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype in ('d','c')`,
};

export async function catalogSnapshot(pool: pg.Pool): Promise<string[]> {
  const out: string[] = [];
  for (const [kind, sql] of Object.entries(QUERIES)) {
    const { rows } = await pool.query({ text: sql, rowMode: "array" });
    for (const r of rows) out.push(`${kind}: ${r[0]}`);
  }
  return out.sort();
}

/** Lines present on only one side (column order is never compared). */
export async function catalogDifferences(a: pg.Pool, b: pg.Pool): Promise<string[]> {
  const [x, y] = await Promise.all([catalogSnapshot(a), catalogSnapshot(b)]);
  const sx = new Set(x);
  const sy = new Set(y);
  return [...x.filter((l) => !sy.has(l)).map((l) => `- ${l}`), ...y.filter((l) => !sx.has(l)).map((l) => `+ ${l}`)];
}
