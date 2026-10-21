// The ownership check: super-deploy assumes the deploy role owns the managed
// schema and everything in it (GLOSSARY "Deploy role", ADR-0006), so later
// migrations can alter and drop what earlier ones created. Ownership is never
// managed or compared (drift ignores it), only checked: the deploy pre-flight
// (deploy, deploy-draft, status), `mark` before asking YES and `init --adopt`
// before reading the target refuse a managed schema, or an object in it,
// whose owner the deploy role doesn't have the privileges of. Without the
// check such a target fails with "must be owner" partway through a deploy.
// `rebuild` before asking checks the managed schema alone
// (`requireManagedSchemaOwned`, QA 172): it drops what is in it, and what it
// creates again is the deploy role's.
//
// "Has the privileges of" is `pg_has_role(current_user, owner, 'USAGE')`,
// what PostgreSQL's own ownership checks use: a superuser, the owner itself,
// or a member that inherits the owner's privileges (so `public`, owned by
// `pg_database_owner`, passes when the deploy role owns the database). A
// membership granted WITH INHERIT FALSE doesn't count, as it doesn't for
// ALTER or DROP. A target without the managed schema yet has nothing to own.
//
// Objects that go with another one are left out, since they change owner with
// it and can't be given away alone: a table's indexes (never listed), a serial
// sequence (its `a` dependency on the table), anything with an internal (`i`)
// dependency (identity sequences, row types, arrays, multiranges, a range's
// constructors) and an extension's members (`e`). Each object comes with the ALTER ... OWNER TO that
// gives it to the deploy role, its names quoted and schema-qualified. What
// `pg_database_owner` owns (`public`) gets ALTER DATABASE ... OWNER TO
// instead, as the README advises: re-owning `public` would break
// PostgreSQL's convention that the database's owner owns it.
//
// `rebuild` judges with the same test what its wipe can drop
// (`objectsNotDroppable`), which is less than ownership: the schema's owner
// may drop anything in it but an extension. Extensions aren't in the
// ownership check, since a deployment never alters or drops one. The wipe
// drops only the extensions in the managed schema, so a member there of an
// extension living elsewhere can't be dropped whoever owns it: it is listed
// with its extension and the extension's owner.

import type { Session } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";

/** A managed-schema object (or the managed schema) the deploy role doesn't own. */
export interface NotOwnedObject {
  /** e.g. `schema app`, `table app.customers`, `function app.answer()`. */
  readonly object: string;
  /**
   * The role that owns it. `pg_database_owner` comes with the database and
   * the role it stands for: `pg_database_owner (the owner of database shop,
   * postgres)`.
   */
  readonly owner: string;
  /**
   * The statement that gives it to the deploy role, e.g. `ALTER TABLE
   * app.customers OWNER TO deployer`; for what `pg_database_owner` owns,
   * `ALTER DATABASE shop OWNER TO deployer`.
   */
  readonly fix: string;
}

/** Something in the managed schema `rebuild`'s wipe can't drop. */
export interface UndroppableObject {
  /** e.g. `extension citext`, `function app.answer()`. */
  readonly object: string;
  /** The role that owns it; for an extension's member, the extension's owner. */
  readonly owner: string;
  /** For a member of an extension outside the managed schema: the extension. */
  readonly extension?: string | undefined;
}

/**
 * Each object kind's catalog row (class, oid), its ALTER keyword and its
 * quoted name. `s` is the managed schema's pg_namespace row, if it exists.
 */
const ownedObjectsQuery = `
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
              AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'a'))
  UNION ALL
  SELECT 'pg_proc'::regclass, p.oid,
         CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
         pg_catalog.format('%I.%I(%s)', s.nspname, p.proname,
                           CASE WHEN p.prokind = 'a' AND p.pronargs = 0 THEN '*'
                                ELSE pg_catalog.pg_get_function_identity_arguments(p.oid) END),
         p.proowner
    FROM pg_catalog.pg_proc p JOIN s ON s.oid = p.pronamespace
  UNION ALL
  SELECT 'pg_type'::regclass, t.oid, CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
         pg_catalog.format('%I.%I', s.nspname, t.typname), t.typowner
    FROM pg_catalog.pg_type t JOIN s ON s.oid = t.typnamespace
  UNION ALL
  SELECT 'pg_operator'::regclass, o.oid, 'OPERATOR',
         pg_catalog.format('%I.%s(%s, %s)', s.nspname, o.oprname,
                           CASE WHEN o.oprleft = 0 THEN 'NONE' ELSE pg_catalog.format_type(o.oprleft, NULL) END,
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
    database: string;
    database_owner: string;
    deploy_role: string;
  }>(
    `WITH s AS (SELECT oid, nspname, nspowner FROM pg_catalog.pg_namespace WHERE nspname = $1),
     owned AS (${ownedObjectsQuery}),
     db AS (SELECT pg_catalog.quote_ident(datname) AS name, pg_catalog.pg_get_userbyid(datdba) AS owner
              FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
     SELECT kind, owned.name, pg_catalog.pg_get_userbyid(owned.owner) AS owner,
            db.name AS database, db.owner AS database_owner,
            pg_catalog.quote_ident(current_user) AS deploy_role
       FROM owned, db
      WHERE NOT pg_catalog.pg_has_role(current_user, owned.owner, 'USAGE')
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend d
                         WHERE d.classid = owned.class AND d.objid = owned.oid AND d.deptype IN ('e', 'i'))
      ORDER BY kind <> 'SCHEMA', kind COLLATE "C", owned.name COLLATE "C"`,
    [managedSchema],
  );
  return rows.map(
    ({ kind, name, owner, database, database_owner, deploy_role }) =>
      owner === databaseOwnerRole
        ? {
            object: `${kind.toLowerCase()} ${name}`,
            owner: `${owner} (the owner of database ${database}, ${database_owner})`,
            fix: `ALTER DATABASE ${database} OWNER TO ${deploy_role}`,
          }
        : {
            object: `${kind.toLowerCase()} ${name}`,
            owner,
            fix: `ALTER ${kind} ${name} OWNER TO ${deploy_role}`,
          },
  );
}

/**
 * The role PostgreSQL 14+ stands in for the database's owner with; it owns
 * `public` from 15 on.
 */
const databaseOwnerRole = "pg_database_owner";

/**
 * The objects in the managed schema (sorted) that the session's current role
 * can't drop, for `rebuild`'s wipe, each with its owner. PostgreSQL lets the
 * schema's owner drop what is in it, so with the managed schema's owner's
 * privileges only extensions owned by someone else are left; without them,
 * every object `objectsNotOwned` lists. Members of an extension outside the
 * managed schema are listed too, whoever owns it: the wipe never drops that
 * extension. Read-only.
 */
export async function objectsNotDroppable(
  session: Session,
  managedSchema: string,
): Promise<UndroppableObject[]> {
  const { rows } = await session.query<{
    kind: string;
    name: string;
    owner: string;
    extension: string | null;
  }>(
    `WITH s AS (SELECT oid, nspname, nspowner FROM pg_catalog.pg_namespace WHERE nspname = $1),
     owned AS (${ownedObjectsQuery}),
     dropped AS (
       SELECT class, oid, kind, name, owner FROM owned
        WHERE kind <> 'SCHEMA' AND NOT pg_catalog.pg_has_role(current_user, (SELECT nspowner FROM s), 'USAGE')
       UNION ALL
       SELECT 'pg_extension'::regclass, e.oid, 'EXTENSION', pg_catalog.quote_ident(e.extname), e.extowner
         FROM pg_catalog.pg_extension e JOIN s ON s.oid = e.extnamespace),
     members_elsewhere AS (
       SELECT owned.kind, owned.name, e.extowner AS owner, pg_catalog.quote_ident(e.extname) AS extension
         FROM owned
         JOIN pg_catalog.pg_depend d ON d.classid = owned.class AND d.objid = owned.oid AND d.deptype = 'e'
         JOIN pg_catalog.pg_extension e ON d.refclassid = 'pg_extension'::regclass AND e.oid = d.refobjid
        WHERE owned.kind <> 'SCHEMA' AND e.extnamespace <> (SELECT oid FROM s))
     SELECT kind, name, pg_catalog.pg_get_userbyid(owner) AS owner, extension FROM (
       SELECT kind, name, owner, NULL AS extension
         FROM dropped
        WHERE NOT pg_catalog.pg_has_role(current_user, owner, 'USAGE')
          AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend d
                           WHERE d.classid = dropped.class AND d.objid = dropped.oid AND d.deptype IN ('e', 'i'))
       UNION ALL
       SELECT kind, name, owner, extension FROM members_elsewhere) undroppable
      ORDER BY kind COLLATE "C", name COLLATE "C"`,
    [managedSchema],
  );
  return rows.map(({ kind, name, owner, extension }) => ({
    object: `${kind.toLowerCase()} ${name}`,
    owner,
    ...(extension === null ? {} : { extension }),
  }));
}

/** One object's line in a refusal: what it is, who owns it, and the fix. */
export function notOwnedMessage(notOwned: NotOwnedObject): string {
  return `${notOwned.object} is owned by ${notOwned.owner}, whose privileges the deploy role doesn't have (fix: ${notOwned.fix})`;
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
 * Throws NotOwnedError, for `rebuild`, if the deploy role doesn't own the
 * managed schema itself. What is in it the wipe drops and the migrations
 * create again, owned by the deploy role; the schema stays as it is, so
 * `deploy` would refuse the rebuilt target.
 */
export async function requireManagedSchemaOwned(
  session: Session,
  target: string,
  managedSchema: string,
): Promise<void> {
  const [first] = await objectsNotOwned(session, managedSchema);
  if (first?.object.startsWith("schema ")) {
    throw new NotOwnedError(target, [first], "rebuild");
  }
}

/**
 * `mark`, `init --adopt` or `rebuild` refused: the managed schema, or an
 * object in it, belongs to a role the deploy role isn't a member of, so a
 * later migration would fail with "must be owner". Nothing was recorded or
 * written.
 */
export class NotOwnedError extends SuperDeployError {
  readonly code = "not-owned";
  readonly target: string;
  /** The managed schema first, then the objects; never empty. */
  readonly objects: readonly NotOwnedObject[];

  /** `rebuild` refuses over the managed schema alone, saying nothing changed. */
  constructor(
    target: string,
    objects: readonly NotOwnedObject[],
    command?: "rebuild",
  ) {
    const listed = objects.map(notOwnedMessage).join("; ");
    super(
      command === "rebuild"
        ? `rebuild can't run on target ${target}: ${listed}, so deploy would refuse the rebuilt target. Fix it, then run rebuild again (nothing changed)`
        : `The deploy role on target ${target} doesn't own everything in the managed schema: ${listed}`,
    );
    this.target = target;
    this.objects = objects;
  }
}
