// GRANT and REVOKE statements as the rules (desired-schema and deploy-time)
// and adoption read them, and the privileges PostgreSQL gives PUBLIC by
// default, the only ones a desired schema may revoke (ADR-0002).
import { type Json, list, unwrap } from "./syntax-tree.ts";

/**
 * PostgreSQL's default privilege for PUBLIC on each object type a desired
 * schema may revoke it on, lowercase as the parser writes privileges.
 * Tables, views and sequences have none. On a schema only `public` has it
 * (a new schema has none).
 */
export const publicDefaults: Readonly<Record<string, string>> = {
  OBJECT_FUNCTION: "execute",
  OBJECT_PROCEDURE: "execute",
  OBJECT_ROUTINE: "execute",
  OBJECT_TYPE: "usage",
  OBJECT_DOMAIN: "usage",
  OBJECT_SCHEMA: "usage",
};

/** The privileges a GRANT or REVOKE names, lowercase; empty for ALL. */
export function privilegeNames(node: Json): string[] {
  return list(node.privileges).map((privilege) =>
    String(unwrap(privilege, "AccessPriv")?.priv_name ?? "all"),
  );
}

/** The schemas a GRANT or REVOKE ON SCHEMA names. */
export function schemaNames(node: Json): string[] {
  return list(node.objects).map((object) =>
    String(unwrap(object, "String")?.sval ?? ""),
  );
}

/**
 * The roles a GRANT or REVOKE names: PUBLIC as null, CURRENT_USER and the
 * like by that keyword, any other role by its name.
 */
export function grantees(node: Json): (string | null)[] {
  return list(node.grantees).map((grantee) => {
    const role = unwrap(grantee, "RoleSpec") ?? {};
    if (role.roletype === "ROLESPEC_PUBLIC") {
      return null;
    }
    return typeof role.rolename === "string"
      ? role.rolename
      : String(role.roletype).replace("ROLESPEC_", "");
  });
}

/**
 * For a GRANT ON SCHEMA, the first privilege it gives besides USAGE (`all`
 * for ALL PRIVILEGES); otherwise undefined. A desired schema grants only
 * USAGE on the managed schema: CREATE belongs to the deploy role's setup.
 */
export function schemaGrantBeyondUsage(node: Json): string | undefined {
  if (node.is_grant !== true || node.objtype !== "OBJECT_SCHEMA") {
    return undefined;
  }
  const privileges = privilegeNames(node);
  return privileges.length === 0
    ? "all"
    : privileges.find((privilege) => privilege !== "usage");
}
