// Wiping the managed schema for `rebuild`, inside its deploy transaction.
// Everything IN the schema is dropped (with CASCADE, so objects elsewhere
// that depend on it go too, as with DROP SCHEMA ... CASCADE), but the schema
// itself stays: its owner, comment and default privileges belong to the
// target's setup, not to the migrations, and dropping the schema would lose
// them. Its grants go back to what a new schema has, so after the replay
// they are exactly what the migrations declare (stories 98-99): every grant
// is revoked except the owner's and the deploy role's own (target setup, as
// in the catalog comparison), and `public` gets back its default USAGE for
// PUBLIC, which the migrations declare by not revoking it.
//
// The drops cover every kind of object a schema can hold. Afterwards the
// schema's dependents in pg_depend (what DROP SCHEMA would have dropped) and
// every other grant must be gone; anything left refuses the rebuild with
// WipeFailedError. A grant is left when the deploy role can't revoke it:
// PostgreSQL revokes only what the revoking role (or, for a superuser or a
// member of the owner, the owner) granted, so a grant the owner made on a
// schema the deploy role doesn't own stays.
import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { type UnrevokedGrant, WipeFailedError } from "../errors.ts";
import { schemaSetupRoles } from "../verification/schema-setup.ts";
import { quoteIdentifier } from "./history.ts";

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
    await session.execute(statement);
  }
  const revokes = await session.query<{ statement: string }>(revokeStatements, [
    namespace,
  ]);
  for (const { statement } of revokes.rows) {
    await session.execute(statement);
  }
  if (schema === "public") {
    await session.execute("GRANT USAGE ON SCHEMA public TO PUBLIC");
  }
  const left = await session.query<{ object: string }>(
    `SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object
       FROM pg_catalog.pg_depend
      WHERE refclassid = 'pg_catalog.pg_namespace'::regclass AND refobjid = $1
        AND classid <> 'pg_catalog.pg_default_acl'::regclass
      ORDER BY 1`,
    [namespace],
  );
  const grants = await session.query<UnrevokedGrant>(grantsLeft, [
    namespace,
    schema === "public",
  ]);
  if (left.rows.length > 0 || grants.rows.length > 0) {
    throw new WipeFailedError(
      target.name,
      schema,
      left.rows.map((row) => row.object),
      grants.rows,
    );
  }
}

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

// The schema's grants to anyone but its owner and the deploy role, $1 the
// schema's oid, with the grantee's name as REVOKE writes it. `grantsLeft`
// also takes $2: whether PUBLIC's USAGE is the default (schema public).
const otherGrants = `
  SELECT e.grantee, e.grantor, e.privilege_type, n.nspname, n.nspowner,
         CASE e.grantee WHEN 0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(e.grantee)) END AS grantee_name
    FROM pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) e
   WHERE n.oid = $1 AND e.grantee NOT IN (${schemaSetupRoles("n.nspowner")})`;

const revokeStatements = `
SELECT DISTINCT format('REVOKE ALL ON SCHEMA %I FROM %s CASCADE', nspname, grantee_name) AS statement
  FROM (${otherGrants}) g
 ORDER BY 1`;

const grantsLeft = `
SELECT privilege_type AS privilege, grantee_name AS grantee,
       quote_ident(pg_catalog.pg_get_userbyid(grantor)) AS grantor,
       grantor = nspowner AS "byOwner"
  FROM (${otherGrants}) g
 WHERE NOT (grantee = 0 AND privilege_type = 'USAGE' AND $2::boolean)
 ORDER BY grantee_name, privilege_type, grantor`;
