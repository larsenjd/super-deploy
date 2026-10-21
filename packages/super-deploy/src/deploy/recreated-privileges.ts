// Warnings for objects a deployment drops and creates again while they carry
// privileges or policies made by hand on the target (QA 183, 184). super-deploy
// still never changes privileges (ADR-0006): this only reads the target, in
// the pre-flight `status`, `deploy` and `deploy-draft` share, and warns.
//
// The objects come from sql-analysis/recreated.ts. For each one the target
// holds, its privileges now are compared with those a new object gets when
// the deploy role (the session's current role) creates it in the managed
// schema: PostgreSQL's built-in defaults (`acldefault`), replaced by the
// role's global `pg_default_acl` entry if it has one, plus its entry for the
// managed schema (per-schema entries only add). Owners are left out on both
// sides, and grant options are ignored. What the object has that a new one
// won't is lost; what a new one gets that the object doesn't is a revoke made
// by hand that comes undone, which widens access (183: a function regains
// PUBLIC's EXECUTE). A table's policies and row-level security are always
// lost, since the desired schema can't declare them.

import type { Session } from "../adapters/types.ts";
import type { ReplayUnit } from "../rehearsal/replay.ts";
import {
  type RecreatedObject,
  recreatedObjects,
} from "../sql-analysis/index.ts";

/** What the target holds for one recreated object. */
interface ObjectPrivileges {
  readonly ord: number;
  /** e.g. `view`, `function`, `domain`. */
  readonly kind: string;
  /** e.g. `app.order_totals`, `app.order_count(cid bigint)`. */
  readonly name: string;
  /** `grantee privilege` pairs the object has and a new one won't get. */
  readonly lost: string[];
  /** `grantee privilege` pairs a new object gets that this one doesn't have. */
  readonly regained: string[];
  readonly policies: string[];
  readonly rowSecurity: boolean;
}

/**
 * One warning per object the `pending` units drop and create again that has
 * grants, revokes, policies or row-level security on the target that the
 * deploy role's default privileges won't give it back. Read-only.
 */
export async function recreatedPrivilegeWarnings(
  session: Session,
  managedSchema: string,
  pending: readonly ReplayUnit[],
): Promise<string[]> {
  const recreated = await recreatedObjects(
    pending.map((unit) => ({
      label: unit.label,
      files: unit.files.map(({ file, sql }) => ({ path: file, text: sql })),
    })),
    managedSchema,
  );
  if (recreated.length === 0) {
    return [];
  }
  const { rows } = await session.query<ObjectPrivileges>(privilegesQuery, [
    recreated.map((object) => object.family),
    recreated.map((object) => object.identity),
    managedSchema,
  ]);
  return rows.flatMap((row) => {
    const object = recreated[row.ord - 1] as RecreatedObject;
    const parts = [
      ...(row.lost.length === 0
        ? []
        : [
            `its grants of ${byGrantee(row.lost, (privileges, grantee) => `${privileges} to ${grantee}`).join(" and of ")} will be lost (default privileges don't restore them)`,
          ]),
      ...(row.regained.length === 0
        ? []
        : [
            `${byGrantee(row.regained, (privileges, grantee) => `${grantee} regains ${privileges}`).join(" and ")}, revoked on the target by hand (default privileges grant ${row.regained.length === 1 ? "it" : "them"} again)`,
          ]),
      ...policyParts(row),
    ];
    if (parts.length === 0) {
      return [];
    }
    const by =
      object.droppedBy === object.createdBy
        ? `is recreated by ${object.droppedBy}`
        : `is dropped by ${object.droppedBy} and created again by ${object.createdBy}`;
    return [`${row.kind} ${row.name} ${by}: ${parts.join("; ")}`];
  });
}

/** `grantee privilege` pairs grouped by grantee, in first-seen order. */
function byGrantee(
  pairs: readonly string[],
  describe: (privileges: string, grantee: string) => string,
): string[] {
  const grouped = new Map<string, string[]>();
  for (const pair of pairs) {
    const space = pair.lastIndexOf(" ");
    const grantee = pair.slice(0, space);
    grouped.set(grantee, [
      ...(grouped.get(grantee) ?? []),
      pair.slice(space + 1),
    ]);
  }
  return [...grouped].map(([grantee, privileges]) =>
    describe(privileges.join(", "), grantee),
  );
}

function policyParts(row: ObjectPrivileges): string[] {
  const policies =
    row.policies.length === 0
      ? undefined
      : `${row.policies.length === 1 ? "policy" : "policies"} ${row.policies.join(", ")}`;
  if (row.rowSecurity) {
    return [
      `its row-level security${policies === undefined ? "" : ` and its ${policies}`} will be lost`,
    ];
  }
  return policies === undefined ? [] : [`its ${policies} will be lost`];
}

// $1: each object's family, $2: its identity (as its DROP names it), $3: the
// managed schema. One row per object the target holds, with `ord` its
// 1-based position in the arrays.
const privilegesQuery = `
WITH wanted AS (
  SELECT w.ord, w.family,
         CASE w.family
           WHEN 'relation' THEN pg_catalog.to_regclass(w.identity)::oid
           WHEN 'routine' THEN coalesce(pg_catalog.to_regprocedure(w.identity)::oid, pg_catalog.to_regproc(w.identity)::oid)
           ELSE pg_catalog.to_regtype(w.identity)::oid
         END AS oid
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS w(family, identity, ord)
),
objects AS (
  SELECT w.ord,
         CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
           WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign table' ELSE 'table' END AS kind,
         pg_catalog.format('%s.%s', n.nspname, c.relname) AS name,
         c.relowner AS owner,
         COALESCE(c.relacl, pg_catalog.acldefault((CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END)::"char", c.relowner)) AS acl,
         CASE c.relkind WHEN 'S' THEN 'S' ELSE 'r' END AS defaults,
         CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END AS builtin,
         c.oid AS relid, c.relrowsecurity AS row_security
    FROM wanted w
    JOIN pg_catalog.pg_class c ON c.oid = w.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE w.family = 'relation'
  UNION ALL
  SELECT w.ord,
         CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
         pg_catalog.format('%s.%s(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)),
         p.proowner,
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner)),
         'f', 'f', NULL, false
    FROM wanted w
    JOIN pg_catalog.pg_proc p ON p.oid = w.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE w.family = 'routine'
  UNION ALL
  SELECT w.ord,
         CASE t.typtype WHEN 'd' THEN 'domain' ELSE 'type' END,
         pg_catalog.format('%s.%s', n.nspname, t.typname),
         t.typowner,
         COALESCE(t.typacl, pg_catalog.acldefault('T', t.typowner)),
         'T', 'T', NULL, false
    FROM wanted w
    JOIN pg_catalog.pg_type t ON t.oid = w.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
   WHERE w.family = 'type'
),
deployer AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user
),
managed AS (
  SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $3
),
now_held AS (
  SELECT o.ord, a.grantee, a.privilege_type
    FROM objects o, pg_catalog.aclexplode(o.acl) a
   WHERE a.grantee <> o.owner
),
for_new AS (
  SELECT o.ord, a.grantee, a.privilege_type
    FROM objects o
   CROSS JOIN deployer d
   CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
           (SELECT g.defaclacl FROM pg_catalog.pg_default_acl g
             WHERE g.defaclrole = d.oid AND g.defaclnamespace = 0 AND g.defaclobjtype = o.defaults::"char"),
           pg_catalog.acldefault(o.builtin::"char", d.oid))) a
   WHERE a.grantee <> d.oid
  UNION
  SELECT o.ord, a.grantee, a.privilege_type
    FROM objects o
   CROSS JOIN deployer d
    JOIN pg_catalog.pg_default_acl g
      ON g.defaclrole = d.oid AND g.defaclobjtype = o.defaults::"char"
     AND g.defaclnamespace = (SELECT oid FROM managed)
   CROSS JOIN LATERAL pg_catalog.aclexplode(g.defaclacl) a
   WHERE a.grantee <> d.oid
),
described AS (
  SELECT ord, privilege_type,
         CASE grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(grantee)::text END AS grantee,
         'lost' AS change
    FROM (SELECT * FROM now_held EXCEPT SELECT * FROM for_new) lost
  UNION ALL
  SELECT ord, privilege_type,
         CASE grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(grantee)::text END,
         'regained'
    FROM (SELECT * FROM for_new EXCEPT SELECT * FROM now_held) regained
)
SELECT o.ord::int AS ord, o.kind, o.name,
       ARRAY(SELECT d.grantee || ' ' || d.privilege_type FROM described d
              WHERE d.ord = o.ord AND d.change = 'lost'
              ORDER BY d.grantee, d.privilege_type) AS lost,
       ARRAY(SELECT d.grantee || ' ' || d.privilege_type FROM described d
              WHERE d.ord = o.ord AND d.change = 'regained'
              ORDER BY d.grantee, d.privilege_type) AS regained,
       ARRAY(SELECT p.polname::text FROM pg_catalog.pg_policy p
              WHERE p.polrelid = o.relid ORDER BY p.polname) AS policies,
       o.row_security AS "rowSecurity"
  FROM objects o
 ORDER BY o.ord`;
