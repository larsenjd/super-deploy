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
const privileges = `privileges and row-level security are ${outside}`;
const readme = '(see the README, "Permissions")';

// Each reason says why, then what to do instead and where it's documented.
const reasons = {
  privileges: `${privileges}; remove it and run it on each target instead ${readme}`,
  defaultPrivileges: `${privileges}; run it on each target as the deploy role, where it grants what every deployment creates ${readme}`,
  roles: `roles, like privileges and row-level security, are ${outside}; create and grant roles on each target instead ${readme}`,
  ownership: `the deploy role owns everything in the managed schema, and ${privileges}; remove it: the deploy role owns everything it creates ${readme}`,
  definer: `the routine would run with the deploy role's rights for every role allowed to call it, and ${privileges}, so nothing here limits who that is; leave the default, SECURITY INVOKER ${readme}`,
} as const;

/** Statement types refused whatever they say, with the reason. */
const refusedStatements: Readonly<Record<string, keyof typeof reasons>> = {
  CreatePolicyStmt: "privileges",
  AlterPolicyStmt: "privileges",
  AlterDefaultPrivilegesStmt: "defaultPrivileges",
  CreateRoleStmt: "roles",
  AlterRoleStmt: "roles",
  AlterRoleSetStmt: "roles",
  DropRoleStmt: "roles",
  AlterOwnerStmt: "ownership",
  ReassignOwnedStmt: "ownership",
  DropOwnedStmt: "ownership",
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

const definer = refusal("SECURITY DEFINER", "definer");

/** Object types renamed by ALTER ... RENAME that are outside super-deploy. */
const refusedRenames: Readonly<
  Record<string, readonly [string, keyof typeof reasons]>
> = {
  OBJECT_POLICY: ["ALTER POLICY ... RENAME", "privileges"],
  OBJECT_ROLE: ["ALTER ROLE ... RENAME", "roles"],
};

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
    case "RenameStmt": {
      const renamed = refusedRenames[String(body.renameType)];
      return renamed === undefined ? undefined : refusal(...renamed);
    }
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
