// Schema rules: objects live in the managed schema and may reference only it
// and pg_catalog. PL/pgSQL bodies may also reference declared external
// schemas. Statements that bind references at CREATE and name an external
// schema pass these rules but fail in rehearsal, which explains why (see
// externalSchemasBoundAtCreate).

import type { ParsedStatement } from "./parse.ts";
import type { RuleContext, RuleFinding } from "./rule-types.ts";
import {
  isObject,
  type Json,
  schemaQualifier,
  statementBody,
  stringList,
  unwrap,
} from "./syntax-tree.ts";

/** Findings for one statement's own object names and references. */
export function schemaFindings(
  statement: ParsedStatement,
  context: RuleContext,
): RuleFinding[] {
  const node = statementBody(statement);
  const targets = targetNames(statement.nodeType, node);
  const findings: RuleFinding[] = [];
  const reported = new Set<string>();
  for (const schema of targets.schemas) {
    if (schema !== context.managedSchema && !reported.has(schema)) {
      reported.add(schema);
      findings.push({
        rule: "outside-managed-schema",
        message: `Objects must live in the managed schema "${context.managedSchema}", not "${schema}": write the name unqualified`,
      });
    }
  }
  const references = [
    ...referencedSchemas(node, targets.nodes),
    ...ownReferences(statement.nodeType, node),
  ];
  findings.push(
    ...referenceFindings(
      references.filter((schema) => !reported.has(schema)),
      context,
      true,
    ),
  );
  return findings;
}

/**
 * `undeclared-schema` findings for referenced schemas. External schemas are
 * accepted when `allowExternal` is true: in PL/pgSQL bodies, and (for the
 * rules only) in statements that bind at CREATE, which rehearsal refuses.
 */
export function referenceFindings(
  schemas: readonly string[],
  context: RuleContext,
  allowExternal: boolean,
  line?: number,
): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const schema of new Set(schemas)) {
    if (
      schema === context.managedSchema ||
      schema === "pg_catalog" ||
      (allowExternal && context.externalSchemas.includes(schema))
    ) {
      continue;
    }
    findings.push({
      rule: "undeclared-schema",
      message: `Schema "${schema}" is not declared: the desired schema may reference only the managed schema "${context.managedSchema}" and pg_catalog (PL/pgSQL bodies may also reference the externalSchemas in super-deploy.config.ts)`,
      ...(line === undefined ? {} : { line }),
    });
  }
  return findings;
}

/**
 * Schemas named by qualified references anywhere in a syntax tree: relations,
 * types (including `%TYPE`), function calls and routine signatures. Objects
 * in `skip` (and everything inside them) are ignored.
 */
export function referencedSchemas(
  node: unknown,
  skip: ReadonlySet<unknown> = new Set(),
): string[] {
  const schemas: string[] = [];
  const visit = (value: unknown): void => {
    if (skip.has(value)) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isObject(value)) {
      return;
    }
    const schema = qualifierOf(value);
    if (schema !== undefined) {
      schemas.push(schema);
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  visit(node);
  return schemas;
}

function qualifierOf(object: Json): string | undefined {
  if (typeof object.relname === "string" && "relpersistence" in object) {
    return typeof object.schemaname === "string"
      ? object.schemaname
      : undefined;
  }
  if ("names" in object && "typemod" in object) {
    const names = stringList(object.names);
    const parts = object.pct_type === true ? 3 : 2;
    return schemaQualifier(names, parts);
  }
  const call = unwrap(object, "FuncCall");
  if (call !== undefined) {
    return schemaQualifier(stringList(call.funcname), 2);
  }
  const routine = unwrap(object, "ObjectWithArgs");
  if (routine !== undefined) {
    return schemaQualifier(stringList(routine.objname), 2);
  }
  return undefined;
}

/** The schemas a statement's own object names are in, and their nodes. */
function targetNames(
  nodeType: string,
  node: Json,
): { schemas: string[]; nodes: Set<unknown> } {
  const nodes = new Set<unknown>();
  const schemas: string[] = [];
  const relation = (value: unknown) => {
    if (isObject(value)) {
      nodes.add(value);
      if (typeof value.schemaname === "string") {
        schemas.push(value.schemaname);
      }
    }
  };
  const named = (value: unknown, parts = 2) => {
    const schema = schemaQualifier(stringList(value), parts);
    if (schema !== undefined) {
      schemas.push(schema);
    }
  };
  switch (nodeType) {
    case "CreateStmt":
    case "IndexStmt":
    case "CreateTrigStmt":
    case "AlterTableStmt":
      relation(node.relation);
      break;
    case "ViewStmt":
      relation(node.view);
      break;
    case "CreateTableAsStmt":
      relation(isObject(node.into) ? node.into.rel : undefined);
      break;
    case "CompositeTypeStmt":
      relation(node.typevar);
      break;
    case "CreateFunctionStmt":
      named(node.funcname);
      break;
    case "CreateDomainStmt":
      named(node.domainname);
      break;
    case "CommentStmt": {
      const object = node.object;
      nodes.add(object);
      if (unwrap(object, "List") !== undefined) {
        // Comment targets like `t.col` or `c on t` carry one more name.
        named(object, commentNameParts[String(node.objtype)] ?? 2);
      } else if (unwrap(object, "ObjectWithArgs") !== undefined) {
        named(unwrap(object, "ObjectWithArgs")?.objname);
      } else {
        for (const schema of referencedSchemas(object)) {
          schemas.push(schema);
        }
      }
      break;
    }
  }
  return { schemas, nodes };
}

const commentNameParts: Record<string, number> = {
  OBJECT_COLUMN: 3,
  OBJECT_TABCONSTRAINT: 3,
  OBJECT_TRIGGER: 3,
};

/** References held in plain name lists rather than reference nodes. */
function ownReferences(nodeType: string, node: Json): string[] {
  const schema =
    nodeType === "CreateTrigStmt"
      ? schemaQualifier(stringList(node.funcname), 2)
      : undefined;
  return schema === undefined ? [] : [schema];
}
