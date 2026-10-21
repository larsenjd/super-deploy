// Wiping the managed schema for `rebuild`, inside its deploy transaction.
// Everything IN the schema is dropped, but the schema itself stays: its
// owner, comment, grants and default privileges belong to the target's
// setup, not to the migrations (ADR-0006), and dropping the schema would
// lose them.
//
// The drops use CASCADE, so objects in other schemas that depend on managed
// ones are dropped too: a view on a managed table, a foreign key to one, a
// column of a managed type (with its data). `rebuild` lists them in its
// confirmation first (`dependentsOutside`), so the person typing YES has
// seen exactly what goes outside the managed schema.
//
// Before asking, `rebuild` refuses a managed schema holding something the
// deploy role can't drop (`requireWipeable`, CannotWipeError, e.g. an
// extension a superuser installed). A drop PostgreSQL refuses all the same
// (something appeared meanwhile) becomes WipeDropFailedError, which says the
// rebuild rolled back. The drops cover every kind of object a schema can
// hold. Afterwards the schema's dependents in pg_depend (what DROP SCHEMA
// would have dropped) must be gone; anything left refuses the rebuild with
// WipeFailedError.

import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { errorReason, SuperDeployError } from "../errors.ts";
import { quoteIdentifier } from "./history.ts";
import { objectsNotDroppable, type UndroppableObject } from "./ownership.ts";

/**
 * Throws CannotWipeError when the managed schema holds something the deploy
 * role can't drop. Read-only, for `rebuild` before it asks.
 */
export async function requireWipeable(
  session: Session,
  target: string,
  schema: string,
): Promise<void> {
  const objects = await objectsNotDroppable(session, schema);
  if (objects.length > 0) {
    throw new CannotWipeError(target, schema, objects);
  }
}

/** Drops every object in `schema` (creating the schema if the target lacks it). */
export async function wipeManagedSchema(
  session: Session,
  target: ResolvedTarget,
  schema: string,
): Promise<void> {
  const { rows } = await session.query<{ oid: number }>(
    "SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1",
    [schema],
  );
  const namespace = rows[0]?.oid;
  if (namespace === undefined) {
    await session.execute(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    return;
  }
  const drops = await session.query<{ statement: string }>(dropStatements, [
    namespace,
  ]);
  for (const { statement } of drops.rows) {
    try {
      await session.execute(statement);
    } catch (error) {
      if (error instanceof SuperDeployError) {
        throw error;
      }
      throw new WipeDropFailedError(target.name, schema, statement, {
        cause: error,
      });
    }
  }
  const left = await session.query<{ object: string }>(
    `SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object
       FROM pg_catalog.pg_depend
      WHERE refclassid = 'pg_catalog.pg_namespace'::regclass AND refobjid = $1
        AND classid <> 'pg_catalog.pg_default_acl'::regclass
      ORDER BY 1`,
    [namespace],
  );
  if (left.rows.length > 0) {
    throw new WipeFailedError(
      target.name,
      schema,
      left.rows.map((row) => row.object),
    );
  }
}

/**
 * What wiping `managedSchema` drops or alters outside it and `historySchema`,
 * described for people and sorted, e.g. `view reporting.customer_names`,
 * `foreign key archive_customer_fk on reporting.orders_archive`, `column
 * reporting.snap.c (with its data)`. Read-only; empty when the target lacks
 * the managed schema.
 */
export async function dependentsOutside(
  session: Session,
  managedSchema: string,
  historySchema: string,
): Promise<string[]> {
  const { rows } = await session.query<{ description: string }>(
    dependentsQuery,
    [managedSchema, historySchema],
  );
  return rows.map((row) => row.description);
}

// `dropped` is everything the wipe's CASCADE reaches, walked as PostgreSQL's
// own dependency walk does: the objects in the schema the wipe drops itself
// (not extension members or default privileges, as below), then whatever
// depends on a dropped object (on the column, when only a column goes), and
// whatever a dropped object is an internal part or extension member of
// (PostgreSQL drops the whole, e.g. the view a rule belongs to). Listed are
// those outside both schemas, leaving out an internal part of any dropped
// object (a managed table's TOAST table, a view's rule and row type), a
// dropped extension's members (its casts have no schema), what goes with
// another listed object (a dropped table's columns, a dropped column's
// default) and a schemaless part of a dropped object (an operator family's
// support function, a table's place in a publication). pg_identify_object gives an extension no schema: its
// extnamespace stands in.
const dependentsQuery = `
WITH RECURSIVE dropped(classid, objid, objsubid) AS (
  SELECT d.classid, d.objid, d.objsubid
    FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_namespace n ON n.oid = d.refobjid
   WHERE d.refclassid = 'pg_catalog.pg_namespace'::regclass AND n.nspname = $1
     AND d.classid <> 'pg_catalog.pg_default_acl'::regclass
     AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend member
                      WHERE member.classid = d.classid AND member.objid = d.objid AND member.deptype = 'e')
  UNION
  SELECT next.classid, next.objid, next.objsubid
    FROM dropped m CROSS JOIN LATERAL (
      SELECT d.classid, d.objid, d.objsubid FROM pg_catalog.pg_depend d
       WHERE d.refclassid = m.classid AND d.refobjid = m.objid
         AND (m.objsubid = 0 OR d.refobjsubid = m.objsubid)
      UNION ALL
      SELECT d.refclassid, d.refobjid, d.refobjsubid FROM pg_catalog.pg_depend d
       WHERE d.classid = m.classid AND d.objid = m.objid
         AND (m.objsubid = 0 OR d.objsubid = m.objsubid) AND d.deptype IN ('i', 'e')
    ) next
),
outside AS (
  SELECT m.classid, m.objid, m.objsubid, o.type, o.schema, o.identity
    FROM dropped m CROSS JOIN LATERAL pg_catalog.pg_identify_object(m.classid, m.objid, m.objsubid) o
   WHERE COALESCE(o.schema, (SELECT n.nspname FROM pg_catalog.pg_extension e
                               JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
                              WHERE m.classid = 'pg_catalog.pg_extension'::regclass AND e.oid = m.objid))
         IS DISTINCT FROM $1
     AND o.schema IS DISTINCT FROM $2
)
SELECT DISTINCT
       CASE WHEN x.type = 'table column' THEN pg_catalog.format('column %s (with its data)', x.identity)
            WHEN x.type = 'table constraint' AND EXISTS (
                   SELECT FROM pg_catalog.pg_constraint c
                    WHERE x.classid = 'pg_catalog.pg_constraint'::regclass AND c.oid = x.objid AND c.contype = 'f')
              THEN pg_catalog.format('foreign key %s', x.identity)
            WHEN x.type = 'table constraint' THEN pg_catalog.format('constraint %s', x.identity)
            ELSE pg_catalog.format('%s %s', x.type, x.identity) END COLLATE "C" AS description
  FROM outside x
 WHERE NOT (x.objsubid <> 0 AND EXISTS (
         SELECT FROM outside whole
          WHERE whole.classid = x.classid AND whole.objid = x.objid AND whole.objsubid = 0))
   AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_depend d
           JOIN dropped owner ON owner.classid = d.refclassid AND owner.objid = d.refobjid
                             AND (owner.objsubid = 0 OR owner.objsubid = d.refobjsubid)
          WHERE d.classid = x.classid AND d.objid = x.objid
            AND (x.objsubid = 0 OR d.objsubid = x.objsubid)
            AND (d.deptype IN ('i', 'e')
                 OR d.deptype = 'a' AND (x.schema IS NULL OR EXISTS (
                      SELECT FROM outside o
                       WHERE o.classid = owner.classid AND o.objid = owner.objid AND o.objsubid = owner.objsubid))))
 ORDER BY 1`;

// One DROP ... IF EXISTS ... CASCADE per object in namespace $1, extensions
// first (their members go with them). Members of extensions are skipped:
// only their extension can drop them. IF EXISTS because an earlier CASCADE
// may already have dropped an object. Names are schema-qualified throughout.
const notExtensionMember = (catalog: string, alias: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend member
                WHERE member.classid = 'pg_catalog.${catalog}'::regclass AND member.objid = ${alias}.oid AND member.deptype = 'e')`;

const dropStatements = `
SELECT statement FROM (
  SELECT 1 AS step, e.extname::text AS name,
         format('DROP EXTENSION IF EXISTS %I CASCADE', e.extname) AS statement
    FROM pg_catalog.pg_extension e WHERE e.extnamespace = $1
  UNION ALL
  SELECT 2, c.relname::text,
         format('DROP %s IF EXISTS %I.%I CASCADE',
                CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                  WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'c' THEN 'TYPE'
                  ELSE 'TABLE' END,
                n.nspname, c.relname)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relnamespace = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
     AND ${notExtensionMember("pg_class", "c")}
  UNION ALL
  SELECT 3, p.proname::text,
         format('DROP ROUTINE IF EXISTS %I.%I(%s) CASCADE', n.nspname, p.proname,
                pg_catalog.pg_get_function_identity_arguments(p.oid))
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE p.pronamespace = $1 AND ${notExtensionMember("pg_proc", "p")}
  UNION ALL
  -- Not row types (their relation goes above), array types (they go with
  -- their element type) or multiranges (they go with their range).
  SELECT 4, t.typname::text,
         format('DROP %s IF EXISTS %I.%I CASCADE',
                CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, n.nspname, t.typname)
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
   WHERE t.typnamespace = $1 AND t.typrelid = 0 AND t.typtype <> 'm'
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type e WHERE e.typarray = t.oid)
     AND ${notExtensionMember("pg_type", "t")}
  UNION ALL
  SELECT 5, o.oprname::text,
         format('DROP OPERATOR IF EXISTS %I.%s (%s, %s) CASCADE', n.nspname, o.oprname,
                CASE o.oprleft WHEN 0 THEN 'NONE' ELSE pg_catalog.format_type(o.oprleft, NULL) END,
                CASE o.oprright WHEN 0 THEN 'NONE' ELSE pg_catalog.format_type(o.oprright, NULL) END)
    FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace
   WHERE o.oprnamespace = $1 AND ${notExtensionMember("pg_operator", "o")}
  UNION ALL
  SELECT 6, f.opfname::text,
         format('DROP OPERATOR FAMILY IF EXISTS %I.%I USING %I CASCADE', n.nspname, f.opfname, a.amname)
    FROM pg_catalog.pg_opfamily f JOIN pg_catalog.pg_namespace n ON n.oid = f.opfnamespace
    JOIN pg_catalog.pg_am a ON a.oid = f.opfmethod
   WHERE f.opfnamespace = $1 AND ${notExtensionMember("pg_opfamily", "f")}
  UNION ALL
  SELECT 7, c.opcname::text,
         format('DROP OPERATOR CLASS IF EXISTS %I.%I USING %I CASCADE', n.nspname, c.opcname, a.amname)
    FROM pg_catalog.pg_opclass c JOIN pg_catalog.pg_namespace n ON n.oid = c.opcnamespace
    JOIN pg_catalog.pg_am a ON a.oid = c.opcmethod
   WHERE c.opcnamespace = $1 AND ${notExtensionMember("pg_opclass", "c")}
  UNION ALL
  SELECT 8, c.collname::text,
         format('DROP COLLATION IF EXISTS %I.%I CASCADE', n.nspname, c.collname)
    FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace
   WHERE c.collnamespace = $1 AND ${notExtensionMember("pg_collation", "c")}
  UNION ALL
  SELECT 9, c.conname::text,
         format('DROP CONVERSION IF EXISTS %I.%I CASCADE', n.nspname, c.conname)
    FROM pg_catalog.pg_conversion c JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
   WHERE c.connamespace = $1 AND ${notExtensionMember("pg_conversion", "c")}
  UNION ALL
  SELECT 10, s.stxname::text,
         format('DROP STATISTICS IF EXISTS %I.%I CASCADE', n.nspname, s.stxname)
    FROM pg_catalog.pg_statistic_ext s JOIN pg_catalog.pg_namespace n ON n.oid = s.stxnamespace
   WHERE s.stxnamespace = $1 AND ${notExtensionMember("pg_statistic_ext", "s")}
  UNION ALL
  SELECT 11, c.cfgname::text,
         format('DROP TEXT SEARCH CONFIGURATION IF EXISTS %I.%I CASCADE', n.nspname, c.cfgname)
    FROM pg_catalog.pg_ts_config c JOIN pg_catalog.pg_namespace n ON n.oid = c.cfgnamespace
   WHERE c.cfgnamespace = $1 AND ${notExtensionMember("pg_ts_config", "c")}
  UNION ALL
  SELECT 12, d.dictname::text,
         format('DROP TEXT SEARCH DICTIONARY IF EXISTS %I.%I CASCADE', n.nspname, d.dictname)
    FROM pg_catalog.pg_ts_dict d JOIN pg_catalog.pg_namespace n ON n.oid = d.dictnamespace
   WHERE d.dictnamespace = $1 AND ${notExtensionMember("pg_ts_dict", "d")}
  UNION ALL
  SELECT 13, p.prsname::text,
         format('DROP TEXT SEARCH PARSER IF EXISTS %I.%I CASCADE', n.nspname, p.prsname)
    FROM pg_catalog.pg_ts_parser p JOIN pg_catalog.pg_namespace n ON n.oid = p.prsnamespace
   WHERE p.prsnamespace = $1 AND ${notExtensionMember("pg_ts_parser", "p")}
  UNION ALL
  SELECT 14, t.tmplname::text,
         format('DROP TEXT SEARCH TEMPLATE IF EXISTS %I.%I CASCADE', n.nspname, t.tmplname)
    FROM pg_catalog.pg_ts_template t JOIN pg_catalog.pg_namespace n ON n.oid = t.tmplnamespace
   WHERE t.tmplnamespace = $1 AND ${notExtensionMember("pg_ts_template", "t")}
) drops
ORDER BY step, name COLLATE "C", statement COLLATE "C"`;

/**
 * rebuild dropped everything it knows how to drop in the managed schema, but
 * objects are left (e.g. members of an extension that lives elsewhere). The
 * transaction rolled back: nothing changed.
 */
export class WipeFailedError extends SuperDeployError {
  readonly code = "wipe-failed";
  readonly target: string;
  readonly schema: string;
  /** PostgreSQL's descriptions of what is left, e.g. `function public.f(integer)`. */
  readonly objects: readonly string[];

  constructor(target: string, schema: string, objects: readonly string[]) {
    super(
      `Could not wipe schema ${schema} on target ${target}: it still holds ${objects.join(", ")}; drop them by hand, then run rebuild again (nothing changed)`,
    );
    this.target = target;
    this.schema = schema;
    this.objects = objects;
  }
}

/**
 * PostgreSQL refused one of the wipe's drops, e.g. `must be owner of
 * extension citext` for an extension installed after rebuild checked. The
 * rebuild rolled back: the target is unchanged.
 */
export class WipeDropFailedError extends SuperDeployError {
  readonly code = "wipe-drop-failed";
  readonly target: string;
  readonly schema: string;
  /** The refused statement, e.g. `DROP EXTENSION IF EXISTS citext CASCADE`. */
  readonly statement: string;

  constructor(
    target: string,
    schema: string,
    statement: string,
    options: ErrorOptions,
  ) {
    super(
      `Could not wipe schema ${schema} on target ${target}: PostgreSQL refused ${statement}: ${errorReason(options.cause)}. The rebuild rolled back: target ${target} is unchanged`,
      options,
    );
    this.target = target;
    this.schema = schema;
    this.statement = statement;
  }
}

/** How `objectsNotDroppable` names an extension, e.g. `extension citext`. */
const extensionPrefix = "extension ";

/**
 * rebuild refused before asking: the managed schema holds objects the deploy
 * role can't drop (e.g. an extension a superuser installed, or a member of
 * an extension living elsewhere). Nothing changed and no attempt was
 * recorded.
 */
export class CannotWipeError extends SuperDeployError {
  readonly code = "cannot-wipe";
  readonly target: string;
  readonly schema: string;
  /** Each object, e.g. `extension citext`, with its owner; never empty. */
  readonly objects: readonly UndroppableObject[];

  constructor(
    target: string,
    schema: string,
    objects: readonly UndroppableObject[],
  ) {
    const describe = ({ object, owner, extension }: UndroppableObject) =>
      extension === undefined
        ? `${object} (owned by ${owner})`
        : `${object} (a member of extension ${extension}, owned by ${owner})`;
    // PostgreSQL can't give an extension another owner: only its owner or a
    // superuser can drop it.
    const owned = objects.filter(({ extension }) => extension === undefined);
    const extensions = owned
      .filter(({ object }) => object.startsWith(extensionPrefix))
      .map(({ object }) => object.slice(extensionPrefix.length));
    const others = owned.length - extensions.length;
    const members = objects.length - owned.length;
    const advice = [
      extensions.length === 0
        ? ""
        : extensions.length === 1
          ? `Have the extension's owner or a superuser run DROP EXTENSION ${extensions.join(", ")} CASCADE`
          : `Have the extensions' owners or a superuser run DROP EXTENSION ${extensions.join(", ")} CASCADE`,
      others === 0
        ? ""
        : others === 1
          ? "Drop it, change its owner to the deploy role, or ask its owner to"
          : "Drop them, change their owners to the deploy role, or ask their owners to",
      members === 0
        ? ""
        : members === 1
          ? "Take it out of its extension (ALTER EXTENSION ... DROP) or drop the extension, as its owner"
          : "Take them out of their extensions (ALTER EXTENSION ... DROP) or drop the extensions, as their owners",
    ]
      .filter((part) => part !== "")
      .map((part, i) =>
        i === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1),
      )
      .join("; ");
    super(
      `rebuild can't wipe schema ${schema} on target ${target}: the deploy role can't drop ${objects.map(describe).join(", ")}. ${advice}, then run rebuild again (nothing changed)`,
    );
    this.target = target;
    this.schema = schema;
    this.objects = objects;
  }
}
