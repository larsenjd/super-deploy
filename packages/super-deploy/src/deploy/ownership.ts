// The ownership check: super-deploy assumes the deploy role owns the managed
// schema and everything in it (GLOSSARY "Deploy role", ADR-0006), so later
// migrations can alter and drop what earlier ones created. Ownership is never
// managed or compared (drift ignores it), only checked: the deploy pre-flight
// (deploy, deploy-draft, status), `mark` before asking YES and `init --adopt`
// before reading the target refuse a managed schema, or an object in it,
// whose owner the deploy role doesn't have the privileges of. Without the
// check such a target fails with "must be owner" partway through a deploy.
//
// "Has the privileges of" is `pg_has_role(current_user, owner, 'USAGE')`,
// what PostgreSQL's own ownership checks use: a superuser, the owner itself,
// or a member that inherits the owner's privileges (so `public`, owned by
// `pg_database_owner`, passes when the deploy role owns the database). A
// membership granted WITH INHERIT FALSE doesn't count, as it doesn't for
// ALTER or DROP. A target without the managed schema yet has nothing to own.
//
// Objects that go with another one are left out, since they change owner with
// it and can't be given away alone: a table's indexes, row type and owned
// (identity or serial) sequences, a type's array and multirange, and an
// extension's members. Each object comes with the ALTER ... OWNER TO that
// gives it to the deploy role, its names quoted and schema-qualified.

import type { Session } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";

/** A managed-schema object (or the managed schema) the deploy role doesn't own. */
export interface NotOwnedObject {
  /** e.g. `schema app`, `table app.customers`, `function app.answer()`. */
  readonly object: string;
  /** The role that owns it. */
  readonly owner: string;
  /** The statement that gives it to the deploy role, e.g. `ALTER TABLE app.customers OWNER TO deployer`. */
  readonly fix: string;
}

/**
 * Each object kind's catalog, with the ALTER keyword and its name. `s` is the
 * managed schema's pg_namespace row.
 */
const ownedObjects = `
  SELECT 'pg_namespace'::regclass AS class, s.oid, 'SCHEMA' AS kind, pg_catalog.quote_ident(s.nspname) AS name, s.nspowner AS owner
    FROM s
  UNION ALL
  SELECT 'pg_class'::regclass, c.oid,
         CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE'
                        WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
         pg_catalog.format('%I.%I', s.nspname, c.relname), c.relowner
    FROM pg_catalog.pg_class c JOIN s ON s.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     AND NOT (c.relkind = 'S' AND EXISTS (
           SELECT FROM pg_catalog.pg_depend d
            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
              AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))
  UNION ALL
  SELECT 'pg_proc'::regclass, p.oid,
         CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
         pg_catalog.format('%I.%I(%s)', s.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)),
         p.proowner
    FROM pg_catalog.pg_proc p JOIN s ON s.oid = p.pronamespace
  UNION ALL
  SELECT 'pg_type'::regclass, t.oid, CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
         pg_catalog.format('%I.%I', s.nspname, t.typname), t.typowner
    FROM pg_catalog.pg_type t JOIN s ON s.oid = t.typnamespace
   WHERE t.typtype <> 'm'
     AND NOT EXISTS (SELECT FROM pg_catalog.pg_type e WHERE e.typarray = t.oid)
     AND NOT EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.reltype = t.oid AND c.relkind <> 'c')
  UNION ALL
  SELECT 'pg_operator'::regclass, o.oid, 'OPERATOR',
         pg_catalog.format('%I.%s(%s, %s)', s.nspname, o.oprname,
                           coalesce(pg_catalog.format_type(o.oprleft, NULL), 'NONE'),
                           pg_catalog.format_type(o.oprright, NULL)),
         o.oprowner
    FROM pg_catalog.pg_operator o JOIN s ON s.oid = o.oprnamespace
  UNION ALL
  SELECT 'pg_opclass'::regclass, oc.oid, 'OPERATOR CLASS',
         pg_catalog.format('%I.%I USING %I', s.nspname, oc.opcname, am.amname), oc.opcowner
    FROM pg_catalog.pg_opclass oc JOIN s ON s.oid = oc.opcnamespace JOIN pg_catalog.pg_am am ON am.oid = oc.opcmethod
  UNION ALL
  SELECT 'pg_opfamily'::regclass, f.oid, 'OPERATOR FAMILY',
         pg_catalog.format('%I.%I USING %I', s.nspname, f.opfname, am.amname), f.opfowner
    FROM pg_catalog.pg_opfamily f JOIN s ON s.oid = f.opfnamespace JOIN pg_catalog.pg_am am ON am.oid = f.opfmethod
  UNION ALL
  SELECT 'pg_collation'::regclass, k.oid, 'COLLATION', pg_catalog.format('%I.%I', s.nspname, k.collname), k.collowner
    FROM pg_catalog.pg_collation k JOIN s ON s.oid = k.collnamespace
  UNION ALL
  SELECT 'pg_conversion'::regclass, v.oid, 'CONVERSION', pg_catalog.format('%I.%I', s.nspname, v.conname), v.conowner
    FROM pg_catalog.pg_conversion v JOIN s ON s.oid = v.connamespace
  UNION ALL
  SELECT 'pg_statistic_ext'::regclass, x.oid, 'STATISTICS', pg_catalog.format('%I.%I', s.nspname, x.stxname), x.stxowner
    FROM pg_catalog.pg_statistic_ext x JOIN s ON s.oid = x.stxnamespace
  UNION ALL
  SELECT 'pg_ts_config'::regclass, g.oid, 'TEXT SEARCH CONFIGURATION', pg_catalog.format('%I.%I', s.nspname, g.cfgname), g.cfgowner
    FROM pg_catalog.pg_ts_config g JOIN s ON s.oid = g.cfgnamespace
  UNION ALL
  SELECT 'pg_ts_dict'::regclass, y.oid, 'TEXT SEARCH DICTIONARY', pg_catalog.format('%I.%I', s.nspname, y.dictname), y.dictowner
    FROM pg_catalog.pg_ts_dict y JOIN s ON s.oid = y.dictnamespace`;

/**
 * The managed schema (first) and every object in it (sorted) whose owner
 * the session's current role doesn't have the privileges of. Read-only.
 */
export async function objectsNotOwned(
  session: Session,
  managedSchema: string,
): Promise<NotOwnedObject[]> {
  const { rows } = await session.query<{
    kind: string;
    name: string;
    owner: string;
    deploy_role: string;
  }>(
    `WITH s AS (SELECT oid, nspname, nspowner FROM pg_catalog.pg_namespace WHERE nspname = $1),
     owned AS (${ownedObjects})
     SELECT kind, name, pg_catalog.pg_get_userbyid(owner) AS owner,
            pg_catalog.quote_ident(current_user) AS deploy_role
       FROM owned
      WHERE NOT pg_catalog.pg_has_role(current_user, owner, 'USAGE')
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend d
                         WHERE d.classid = owned.class AND d.objid = owned.oid AND d.deptype = 'e')
      ORDER BY kind <> 'SCHEMA', kind COLLATE "C", name COLLATE "C"`,
    [managedSchema],
  );
  return rows.map(({ kind, name, owner, deploy_role }) => ({
    object: `${kind.toLowerCase()} ${name}`,
    owner,
    fix: `ALTER ${kind} ${name} OWNER TO ${deploy_role}`,
  }));
}

/** One object's line in a refusal: what it is, who owns it, and the fix. */
export function notOwnedMessage(notOwned: NotOwnedObject): string {
  return `${notOwned.object} is owned by ${notOwned.owner}, which the deploy role isn't a member of (fix: ${notOwned.fix})`;
}

/**
 * Throws NotOwnedError if the deploy role doesn't own the managed schema and
 * everything in it.
 */
export async function requireOwnership(
  session: Session,
  target: string,
  managedSchema: string,
): Promise<void> {
  const notOwned = await objectsNotOwned(session, managedSchema);
  if (notOwned.length > 0) {
    throw new NotOwnedError(target, notOwned);
  }
}

/**
 * `mark` or `init --adopt` refused: the managed schema, or an object in it,
 * belongs to a role the deploy role isn't a member of, so a later migration
 * would fail with "must be owner". Nothing was recorded or written.
 */
export class NotOwnedError extends SuperDeployError {
  readonly code = "not-owned";
  readonly target: string;
  /** The managed schema first, then the objects; never empty. */
  readonly objects: readonly NotOwnedObject[];

  constructor(target: string, objects: readonly NotOwnedObject[]) {
    super(
      `The deploy role on target ${target} doesn't own everything in the managed schema: ${objects.map(notOwnedMessage).join("; ")}`,
    );
    this.target = target;
    this.objects = objects;
  }
}
