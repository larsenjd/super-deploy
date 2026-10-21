// Privileges, roles, ownership, row-level security and SECURITY DEFINER are
// outside super-deploy (ADR-0006): it knows one role, the deploy role, which
// owns the managed schema and everything in it. Grants, policies and RLS are
// set up on targets by hand, so every file super-deploy deploys refuses the
// statements that would change them. Both rule sets (desired-schema-rules.ts,
// deploy-time.ts) ask here first. The refusals are `unsupported-object`, which
// no override marker bypasses.
//
// COMMENT ON POLICY is left to each rule set's COMMENT rule.
import type { ParsedStatement } from "./parse.ts";
import type { RuleId } from "./rule-catalogue.ts";
import { objectTypeKeyword, statementName } from "./statement-names.ts";
import {
  alterTableCommands,
  defElems,
  type Json,
  statementBody,
  unwrap,
} from "./syntax-tree.ts";

const outside = "set up on targets outside super-deploy";

const reasons = {
  privileges: `privileges and row-level security are ${outside}`,
  roles: `roles, like privileges and row-level security, are ${outside}`,
  ownership: `the deploy role owns everything in the managed schema; privileges and row-level security are ${outside}`,
  definer: `the routine would run with the deploy role's rights for every role allowed to call it, and privileges, which decide who that is, are ${outside}; leave the default, SECURITY INVOKER`,
} as const;

/** Statement types refused whatever they say, with the reason. */
const refusedStatements: Readonly<Record<string, keyof typeof reasons>> = {
  CreatePolicyStmt: "privileges",
  AlterPolicyStmt: "privileges",
  AlterDefaultPrivilegesStmt: "privileges",
  CreateRoleStmt: "roles",
  AlterRoleStmt: "roles",
  DropRoleStmt: "roles",
  DropOwnedStmt: "roles",
  AlterOwnerStmt: "ownership",
  ReassignOwnedStmt: "ownership",
};

const rowSecurityCommands: Readonly<Record<string, string>> = {
  AT_EnableRowSecurity: "ENABLE ROW LEVEL SECURITY",
  AT_DisableRowSecurity: "DISABLE ROW LEVEL SECURITY",
  AT_ForceRowSecurity: "FORCE ROW LEVEL SECURITY",
  AT_NoForceRowSecurity: "NO FORCE ROW LEVEL SECURITY",
};

interface Refusal {
  readonly rule: RuleId;
  readonly message: string;
}

const refusal = (what: string, reason: keyof typeof reasons): Refusal => ({
  rule: "unsupported-object",
  message: `${what} is not supported: ${reasons[reason]}`,
});

/**
 * Why super-deploy refuses a statement that grants, revokes, manages roles
 * or ownership, creates or changes a policy or row-level security, or makes
 * a routine SECURITY DEFINER; undefined for any other statement.
 */
export function privilegeRefusal(
  statement: ParsedStatement,
): Refusal | undefined {
  const type = statement.nodeType;
  const body = statementBody(statement);
  const reason = refusedStatements[type];
  if (reason !== undefined) {
    return refusal(statementName(type), reason);
  }
  switch (type) {
    case "GrantStmt":
      return refusal(body.is_grant === true ? "GRANT" : "REVOKE", "privileges");
    case "GrantRoleStmt":
      return refusal(
        body.is_grant === true ? "GRANT role" : "REVOKE role",
        "roles",
      );
    case "DropStmt":
      return body.removeType === "OBJECT_POLICY"
        ? refusal("DROP POLICY", "privileges")
        : undefined;
    case "RenameStmt":
      return body.renameType === "OBJECT_POLICY"
        ? refusal("ALTER POLICY ... RENAME", "privileges")
        : undefined;
    case "AlterTableStmt":
      return alterTableRefusal(body);
    case "CreateFunctionStmt":
      return isSecurityDefiner(body.options) ? definer : undefined;
    case "AlterFunctionStmt":
      return isSecurityDefiner(body.actions) ? definer : undefined;
    default:
      return undefined;
  }
}

const definer = refusal("SECURITY DEFINER", "definer");

function alterTableRefusal(body: Json): Refusal | undefined {
  for (const command of alterTableCommands(body)) {
    const subtype = String(command.subtype ?? "");
    const rowSecurity = rowSecurityCommands[subtype];
    if (rowSecurity !== undefined) {
      return refusal(`ALTER TABLE ... ${rowSecurity}`, "privileges");
    }
    if (subtype === "AT_ChangeOwner") {
      return refusal(
        `ALTER ${objectTypeKeyword(body.objtype)} ... OWNER TO`,
        "ownership",
      );
    }
  }
  return undefined;
}

/** True when routine options (or ALTER FUNCTION actions) say SECURITY DEFINER. */
function isSecurityDefiner(options: unknown): boolean {
  return defElems(options).some(
    ({ name, arg }) =>
      name === "security" && unwrap(arg, "Boolean")?.boolval === true,
  );
}
