// Supported extensions (ADR-0009) as SQL analysis sees them: the clauses of
// a `CREATE EXTENSION`, and what the extension provides at the version it
// pins. The supported set and each version's objects come from the
// generated supported-extensions.ts; the desired-schema rules check a
// statement against the config, the deploy-time rules accept a schema
// change's, and ordering resolves references against what it provides.
// The refusals both rule sets share are worded here once.

import type { ParsedStatement } from "./parse.ts";
import type { RuleId } from "./rule-catalogue.ts";
import type { ListedExtensions } from "./rule-types.ts";
import { quoteIdentifier } from "./statement-names.ts";
import {
  type ExtensionObjects,
  type SupportedExtension,
  supportedExtensionObjects,
  supportedExtensionVersions,
} from "./supported-extensions.ts";
import {
  defElemString,
  defElems,
  type Json,
  stringList,
  unwrap,
} from "./syntax-tree.ts";

/** What a `CREATE EXTENSION` statement says, from its syntax tree. */
export interface CreateExtension {
  readonly name: string;
  /** The `VERSION`, if given. */
  readonly version: string | undefined;
  /** The `SCHEMA`, if given. */
  readonly schema: string | undefined;
  readonly cascade: boolean;
}

/** The clauses of a `CreateExtensionStmt` body. */
export function createExtension(node: Json): CreateExtension {
  const options = defElems(node.options);
  const option = (name: string) =>
    options.find((element) => element.name === name);
  return {
    name: typeof node.extname === "string" ? node.extname : "",
    version: defElemString(option("new_version")?.arg),
    schema: defElemString(option("schema")?.arg),
    cascade: option("cascade") !== undefined,
  };
}

/**
 * Each extension other than plpgsql that `statements` create at a pinned
 * `VERSION`, in statement order.
 */
export function pinnedExtensions(
  statements: readonly ParsedStatement[],
): { readonly name: string; readonly version: string }[] {
  return statements.flatMap((statement) => {
    const body = unwrap(statement.node, "CreateExtensionStmt");
    if (body === undefined) {
      return [];
    }
    const { name, version } = createExtension(body);
    return name === "plpgsql" || version === undefined
      ? []
      : [{ name, version }];
  });
}

/**
 * An extension statement a deployment runs: a `CREATE EXTENSION` (its
 * `VERSION` if given), an `ALTER EXTENSION ... UPDATE TO` or a
 * `DROP EXTENSION` (one per extension it names, without a version).
 */
export interface ExtensionChange {
  readonly name: string;
  readonly version: string | undefined;
  readonly change: "create" | "update" | "drop";
}

/**
 * Each `CREATE EXTENSION`, `ALTER EXTENSION ... UPDATE TO` and
 * `DROP EXTENSION` in `statements` other than plpgsql's, in statement order:
 * what a target must be able to install for them to run, and which
 * extensions they drop first.
 */
export function extensionChanges(
  statements: readonly ParsedStatement[],
): ExtensionChange[] {
  return statements.flatMap((statement): ExtensionChange[] => {
    const create = unwrap(statement.node, "CreateExtensionStmt");
    const alter = unwrap(statement.node, "AlterExtensionStmt");
    const drop = unwrap(statement.node, "DropStmt");
    const found: ExtensionChange[] =
      create !== undefined
        ? [{ ...versionOf(create), change: "create" }]
        : alter !== undefined
          ? [{ ...versionOf(alter), change: "update" }]
          : drop?.removeType === "OBJECT_EXTENSION"
            ? stringList(drop.objects).map((name) => ({
                name,
                version: undefined,
                change: "drop",
              }))
            : [];
    return found.filter(
      ({ name, version, change }) =>
        name !== "plpgsql" && (change !== "update" || version !== undefined),
    );
  });
}

function versionOf(node: Json): {
  name: string;
  version: string | undefined;
} {
  const { name, version } = createExtension(node);
  return { name, version };
}

export { compareExtensionVersions } from "./version-order.ts";

/** True for one of the 17 supported extensions. */
export function isSupportedExtension(name: string): name is SupportedExtension {
  return Object.hasOwn(supportedExtensionVersions, name);
}

/**
 * An extension's name as SQL writes it: bare for a supported extension
 * whose name is a plain identifier (none is a keyword), else quoted
 * (`"uuid-ossp"`).
 */
export function extensionSqlName(name: string): string {
  return isSupportedExtension(name) && /^[a-z_][a-z0-9_]*$/.test(name)
    ? name
    : quoteIdentifier(name);
}

/** The supported extensions' names, comma-separated, for messages. */
export function supportedExtensionList(): string {
  return Object.keys(supportedExtensionVersions).join(", ");
}

/**
 * What a supported extension provides at `version`, or undefined when the
 * extension isn't supported or the tool doesn't know that version.
 */
export function extensionObjects(
  name: string,
  version: string | undefined,
): ExtensionObjects | undefined {
  if (version === undefined || !isSupportedExtension(name)) {
    return undefined;
  }
  const versions = supportedExtensionObjects[name];
  return Object.hasOwn(versions, version) ? versions[version] : undefined;
}

/**
 * The names of the functions the listed extensions provide at any version
 * listed for them: what deploy-time SQL may call besides pg_catalog's.
 */
export function listedExtensionFunctions(
  extensions: ListedExtensions,
): Set<string> {
  const names = new Set<string>();
  for (const [name, versions] of Object.entries(extensions)) {
    for (const version of versions) {
      for (const routine of extensionObjects(name, version)?.functions ?? []) {
        names.add(routine.name);
      }
    }
  }
  return names;
}

/** A refusal of an extension statement, by a rule of the catalogue. */
export interface ExtensionFinding {
  readonly rule: RuleId;
  readonly message: string;
}

/** `name` isn't one of the supported extensions. */
export function unsupportedExtensionFinding(name: string): ExtensionFinding {
  return {
    rule: "unsupported-extension",
    message: `${name} is not a supported extension: supported extensions are ${supportedExtensionList()}`,
  };
}

/**
 * A supported extension a database holds in `schema`, outside the managed
 * schema, where every extension lives.
 */
export function extensionElsewhereFinding(
  name: string,
  schema: string,
  managedSchema: string,
): ExtensionFinding {
  return {
    rule: "extension-outside-managed-schema",
    message: `${name} is in schema ${schema}, outside the managed schema ${managedSchema}, where extensions live: move it there (ALTER EXTENSION ${extensionSqlName(name)} SET SCHEMA ${quoteIdentifier(managedSchema)}) or drop it`,
  };
}

/** The refusals of a supported extension's `SCHEMA` and `CASCADE` clauses. */
export function extensionClauseFindings(
  statement: CreateExtension,
  managedSchema: string,
): ExtensionFinding[] {
  const findings: ExtensionFinding[] = [];
  if (statement.schema !== undefined && statement.schema !== managedSchema) {
    findings.push({
      rule: "extension-outside-managed-schema",
      message: `Extensions live in the managed schema ${managedSchema}: leave SCHEMA ${statement.schema} out`,
    });
  }
  if (statement.cascade) {
    findings.push({
      rule: "extension-cascade",
      message:
        "CASCADE is not allowed: create every extension the desired schema needs with a CREATE EXTENSION of its own",
    });
  }
  return findings;
}

/** `COMMENT ON EXTENSION`, refused for every extension. */
export const extensionCommentFinding: ExtensionFinding = {
  rule: "extension-comment",
  message:
    "COMMENT ON EXTENSION is not allowed: each extension keeps the comment its install script writes",
};
