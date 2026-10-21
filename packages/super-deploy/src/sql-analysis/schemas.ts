// Schema rules: objects live in the managed schema and may reference only it
// and pg_catalog. PL/pgSQL bodies may also reference declared external
// schemas. Statements that bind references at CREATE and name an external
// schema pass these rules but fail in rehearsal, which explains why (see
// externalSchemasBoundAtCreate).

import type { ParsedStatement } from "./parse.ts";
import type {
  RuleContext,
  RuleFinding,
  SchemaReference,
} from "./rule-types.ts";
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
    ...qualifiedReferences(node, targets.nodes),
    ...ownReferences(statement.nodeType, node),
  ];
  findings.push(
    ...referenceFindings(
      references.filter(({ schema }) => !reported.has(schema)),
      context,
      "bound-at-create",
    ),
  );
  return findings;
}

/** A schema-qualified name a statement references, e.g. `public.citext`. */
export interface QualifiedReference {
  readonly schema: string;
  /** The name as written, schema first: `public.citext`, `other.t.a`. */
  readonly name: string;
}

/**
 * `undeclared-schema` findings for referenced schemas, one per schema,
 * `where` they are referenced (each finding records it) and naming each
 * reference to it once. External schemas are accepted: in PL/pgSQL bodies,
 * and (for the rules only) in statements that bind at CREATE, which
 * rehearsal refuses. A reference bound at CREATE can never be to another
 * schema, so its finding says declaring the schema won't help.
 */
export function referenceFindings(
  references: readonly QualifiedReference[],
  context: RuleContext,
  where: SchemaReference["where"],
  line?: number,
): RuleFinding[] {
  const bySchema = new Map<string, Set<string>>();
  for (const { schema, name } of references) {
    if (
      schema !== context.managedSchema &&
      schema !== "pg_catalog" &&
      !context.externalSchemas.includes(schema)
    ) {
      bySchema.set(schema, (bySchema.get(schema) ?? new Set()).add(name));
    }
  }
  return [...bySchema].map(([schema, named]) => {
    const names = [...named];
    const listed = names.join(", ");
    return {
      rule: "undeclared-schema",
      message:
        where === "plpgsql-body"
          ? `Schema "${schema}" is not declared (${listed}): the desired schema may reference only the managed schema "${context.managedSchema}" and pg_catalog (PL/pgSQL bodies may also reference the externalSchemas in super-deploy.config.ts)`
          : `Schema "${schema}" can't be referenced here (${listed}): tables, views, defaults, types and everything else PostgreSQL binds at CREATE may reference only the managed schema "${context.managedSchema}" and pg_catalog, and declaring it in externalSchemas won't help (only PL/pgSQL bodies may reference external schemas)`,
      ...(line === undefined ? {} : { line }),
      reference: { schema, names, where },
    };
  });
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
  return qualifiedReferences(node, skip).map(({ schema }) => schema);
}

/** `referencedSchemas`, each with the name that is qualified with it. */
export function qualifiedReferences(
  node: unknown,
  skip: ReadonlySet<unknown> = new Set(),
): QualifiedReference[] {
  const references: QualifiedReference[] = [];
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
    const reference = qualifierOf(value);
    if (reference !== undefined) {
      references.push(reference);
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  visit(node);
  return references;
}

function qualifierOf(object: Json): QualifiedReference | undefined {
  if (typeof object.relname === "string" && "relpersistence" in object) {
    return typeof object.schemaname === "string"
      ? {
          schema: object.schemaname,
          name: `${object.schemaname}.${object.relname}`,
        }
      : undefined;
  }
  if ("names" in object && "typemod" in object) {
    return qualified(
      stringList(object.names),
      object.pct_type === true ? 3 : 2,
    );
  }
  const call = unwrap(object, "FuncCall");
  if (call !== undefined) {
    return qualified(stringList(call.funcname), 2);
  }
  const routine = unwrap(object, "ObjectWithArgs");
  if (routine !== undefined) {
    return qualified(stringList(routine.objname), 2);
  }
  return undefined;
}

/** A dotted name with at least `parts` parts, as a qualified reference. */
function qualified(
  names: readonly string[],
  parts: number,
): QualifiedReference | undefined {
  const schema = schemaQualifier(names, parts);
  return schema === undefined ? undefined : { schema, name: names.join(".") };
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
function ownReferences(nodeType: string, node: Json): QualifiedReference[] {
  const reference =
    nodeType === "CreateTrigStmt"
      ? qualified(stringList(node.funcname), 2)
      : undefined;
  return reference === undefined ? [] : [reference];
}
