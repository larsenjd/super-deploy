// Routine bodies held as strings, which the main parse leaves unparsed.
//
// PL/pgSQL bodies (spec "Rules: PL/pgSQL bodies") are parsed with
// libpg-query's PL/pgSQL parser: EXECUTE, COMMIT/ROLLBACK, denylisted calls
// and references to undeclared schemas are refused. The embedded SQL is text,
// so each expression is parsed again with the SQL parser. Declared external
// schemas are allowed here and only here.
//
// LANGUAGE sql string bodies get the same denylist and schema checks.
// PostgreSQL validates them at CREATE, but like PL/pgSQL bodies it resolves
// their names again at each call, with the caller's search_path.
//
// That makes a body that names a managed-schema object without a schema
// fail for every caller whose search_path lacks the managed schema, though
// rehearsals and deployments (which pin search_path to it) pass: with a
// managed schema other than `public`, that is every caller by default.
// `unqualifiedNameWarnings` warns about such routines (QA 180: the
// maintainer chose a warning over a refusal); `public` is on every default
// search_path, so it gets none. A `SET search_path` option or a `BEGIN
// ATOMIC` body (bound at CREATE) avoids it.
//
// Every statement in either kind of body gets the privilege refusals
// (privileges.ts) on its own line, as it would at top level: a body runs as
// whoever calls it, and a trigger fired by a deployment's script runs it as
// the deploy role.
//
// Both use the *Sync parsers, so they run only after parseSqlFile has loaded
// the WASM module (checkRules always parses the file first).
import { parsePlPgSQLSync, parseSync } from "libpg-query";
import { listed } from "../errors.ts";
import { denylistFindings } from "./denylist.ts";
import { lineAtByte, type ParsedStatement } from "./parse.ts";
import { privilegeRefusal } from "./privileges.ts";
import { statementFacts, unqualifiedReferences } from "./references.ts";
import type { RuleContext, RuleFinding } from "./rule-types.ts";
import { referencedSchemas, referenceFindings } from "./schemas.ts";
import {
  defElemString,
  defElems,
  isObject,
  type Json,
  unwrap,
  walk,
} from "./syntax-tree.ts";

export function plpgsqlFindings(
  statement: ParsedStatement,
  body: unknown,
  context: RuleContext,
): RuleFinding[] {
  let parsed: unknown;
  try {
    parsed = parsePlPgSQLSync(statement.text);
  } catch (error) {
    return [
      {
        rule: "syntax-error",
        message: `Syntax error in the PL/pgSQL body: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  const firstLine = bodyFirstLine(statement, body);
  const findings: RuleFinding[] = [];
  const visit = (value: unknown, lineno: number): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, lineno);
      }
      return;
    }
    if (!isObject(value)) {
      return;
    }
    const here = linenoOf(value) ?? lineno;
    const line = firstLine + Math.max(here, 1) - 1;
    findings.push(...plpgsqlNodeFindings(value, line, context));
    for (const child of Object.values(value)) {
      visit(child, here);
    }
  };
  visit(parsed, 1);
  return unique(findings);
}

/** A node's own line: `{lineno}` or a wrapped `{ PLpgSQL_stmt_x: {lineno} }`. */
function linenoOf(object: Json): number | undefined {
  if (typeof object.lineno === "number") {
    return object.lineno;
  }
  const values = Object.values(object);
  const [inner] = values;
  return values.length === 1 &&
    isObject(inner) &&
    typeof inner.lineno === "number"
    ? inner.lineno
    : undefined;
}

function plpgsqlNodeFindings(
  object: Json,
  line: number,
  context: RuleContext,
): RuleFinding[] {
  if (
    "PLpgSQL_stmt_dynexecute" in object ||
    "PLpgSQL_stmt_dynfors" in object ||
    "dynquery" in object
  ) {
    return [
      {
        rule: "plpgsql-dynamic-sql",
        message:
          "EXECUTE (dynamic SQL) is not allowed in PL/pgSQL bodies: SQL built at run time can't be checked by the rules",
        line,
      },
    ];
  }
  for (const [key, word] of [
    ["PLpgSQL_stmt_commit", "COMMIT"],
    ["PLpgSQL_stmt_rollback", "ROLLBACK"],
  ] as const) {
    if (key in object) {
      return [
        {
          rule: "plpgsql-transaction-control",
          message: `${word} is not allowed in PL/pgSQL bodies: it would end the deployment's transaction`,
          line,
        },
      ];
    }
  }
  const datatype = object.datatype;
  if (isObject(datatype) && typeof object.lineno === "number") {
    const typname = (datatype.PLpgSQL_type as Json | undefined)?.typname;
    if (typeof typname === "string") {
      const schema = declaredTypeSchema(typname);
      return schema === undefined
        ? []
        : referenceFindings([schema], context, "bound-at-create", line);
    }
  }
  const expression = object.PLpgSQL_expr;
  if (isObject(expression) && typeof expression.query === "string") {
    const tree = parseEmbedded(
      expression.query,
      Number(expression.parseMode ?? 0),
    );
    if (tree === undefined) {
      return [];
    }
    return [
      ...privilegeFindings(tree, () => line),
      ...denylistFindings(tree, line),
      ...notifyFindings(tree, line),
      ...referenceFindings(
        referencedSchemas(tree),
        context,
        "plpgsql-body",
        line,
      ),
    ];
  }
  return [];
}

/** Parses a PL/pgSQL expression's SQL text, or undefined if it doesn't parse. */
function parseEmbedded(query: string, parseMode: number): unknown {
  let sql = query;
  if (parseMode === 2) {
    sql = `SELECT ${query}`;
  } else if (parseMode >= 3) {
    // Assignments: `target := expression` (or `=`).
    const assign = query.indexOf(":=");
    const index = assign >= 0 ? assign + 2 : query.indexOf("=") + 1;
    sql = `SELECT ${query.slice(index)}`;
  }
  try {
    return parseSync(sql);
  } catch {
    // PostgreSQL itself refuses an unparseable body at CREATE.
    return undefined;
  }
}

/**
 * The privilege refusal of each statement in a parsed body, on the line
 * `lineOf` gives for the statement's byte offset in the parsed text.
 */
function privilegeFindings(
  tree: unknown,
  lineOf: (location: number) => number,
): RuleFinding[] {
  const statements =
    (tree as { stmts?: { stmt?: Json; stmt_location?: number }[] }).stmts ?? [];
  return statements.flatMap(({ stmt, stmt_location }) => {
    const refusal =
      stmt === undefined
        ? undefined
        : privilegeRefusal({
            nodeType: Object.keys(stmt)[0] ?? "",
            node: stmt as unknown as ParsedStatement["node"],
          });
    return refusal === undefined
      ? []
      : [{ ...refusal, line: lineOf(stmt_location ?? 0) }];
  });
}

function notifyFindings(tree: unknown, line: number): RuleFinding[] {
  return JSON.stringify(tree).includes('"NotifyStmt"')
    ? [
        {
          rule: "denylisted-call",
          message:
            "NOTIFY is not allowed: it sends a notification other sessions act on, which a failed deployment's rollback cannot undo",
          line,
        },
      ]
    : [];
}

/** The schema in a declared variable type: `s.t%ROWTYPE`, `s.t.c%TYPE`, `s.ty`. */
function declaredTypeSchema(typname: string): string | undefined {
  const match = /^(.*?)%(row)?type$/i.exec(typname.trim());
  if (match !== null) {
    const parts = identifierChain(match[1] ?? "");
    const needed = match[2] === undefined ? 3 : 2;
    return parts.length >= needed ? parts[0] : undefined;
  }
  try {
    return referencedSchemas(parseSync(`SELECT NULL::${typname}`))[0];
  } catch {
    return undefined;
  }
}

function identifierChain(text: string): string[] {
  const parts: string[] = [];
  const pattern = /\s*(?:"((?:[^"]|"")*)"|([^."\s]+))\s*(?:\.|$)/gy;
  for (const match of text.matchAll(pattern)) {
    parts.push(
      match[1] !== undefined
        ? match[1].replaceAll('""', '"')
        : (match[2] ?? "").toLowerCase(),
    );
  }
  return parts;
}

export function sqlBodyFindings(
  statement: ParsedStatement,
  body: unknown,
  context: RuleContext,
): RuleFinding[] {
  const text = defElemString(body);
  if (text === undefined || text.trim() === "") {
    return [];
  }
  let tree: unknown;
  try {
    tree = parseSync(text);
  } catch {
    // PostgreSQL itself refuses an unparseable body at CREATE.
    return [];
  }
  const line = bodyFirstLine(statement, body);
  const bytes = Buffer.from(text, "utf8");
  return unique([
    ...privilegeFindings(
      tree,
      (location) => line + lineAtByte(bytes, location) - 1,
    ),
    ...denylistFindings(tree, line),
    ...referenceFindings(
      referencedSchemas(tree),
      context,
      "bound-at-create",
      line,
    ),
  ]);
}

/** The file line where a routine's string body starts. */
function bodyFirstLine(statement: ParsedStatement, body: unknown): number {
  const text = defElemString(body);
  const index = text === undefined ? -1 : statement.text.indexOf(text);
  if (index < 0) {
    return statement.line;
  }
  return (
    statement.line + (statement.text.slice(0, index).split("\n").length - 1)
  );
}

function unique(findings: RuleFinding[]): RuleFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.line}\u0000${finding.rule}\u0000${finding.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Declared external schemas that a desired-schema statement references in
 * places PostgreSQL resolves at CREATE (everything except PL/pgSQL statement
 * bodies, but including PL/pgSQL variable declarations). Rehearsals don't
 * contain external schemas, so such a statement can never load; this names
 * the schemas for the error's hint.
 */
export function externalSchemasBoundAtCreate(
  statement: ParsedStatement,
  externalSchemas: readonly string[],
): string[] {
  const schemas = referencedSchemas(statement.node);
  const routine = unwrap(statement.node, "CreateFunctionStmt");
  if (routine !== undefined) {
    const options = defElems(routine.options);
    const language = defElemString(
      options.find((option) => option.name === "language")?.arg,
    )?.toLowerCase();
    const body = options.find((option) => option.name === "as")?.arg;
    if (language === "sql") {
      const text = defElemString(body);
      try {
        schemas.push(...referencedSchemas(parseSync(text ?? "")));
      } catch {
        // Unparseable or empty: PostgreSQL reports it.
      }
    } else if (language === "plpgsql") {
      try {
        walk(parsePlPgSQLSync(statement.text), (object) => {
          const typname = (
            (isObject(object.datatype) ? object.datatype : {}).PLpgSQL_type as
              | Json
              | undefined
          )?.typname;
          const schema =
            typeof typname === "string"
              ? declaredTypeSchema(typname)
              : undefined;
          if (schema !== undefined) {
            schemas.push(schema);
          }
        });
      } catch {
        // PostgreSQL reports body syntax errors.
      }
    }
  }
  return [...new Set(schemas)].filter((schema) =>
    externalSchemas.includes(schema),
  );
}

/** A desired-schema routine whose body names managed-schema objects unqualified. */
export interface UnqualifiedNameWarning {
  /** Project-relative path of the desired-schema file. */
  readonly file: string;
  /** The line of its CREATE statement. */
  readonly line: number;
  /** As ordering names it, e.g. `function order_count(int8)`. */
  readonly routine: string;
  /** The objects of the desired schema its body names without a schema. */
  readonly names: readonly string[];
  readonly message: string;
}

/**
 * The desired schema's routines with a string body that names one of its
 * objects without a schema and no `SET search_path`; none when the managed
 * schema is `public`.
 */
export function unqualifiedNameWarnings(
  statements: readonly ParsedStatement[],
  managedSchema: string,
): UnqualifiedNameWarning[] {
  if (managedSchema === "public") {
    return [];
  }
  const facts = statements.map((statement) => ({
    statement,
    facts: statementFacts(statement.node, managedSchema),
  }));
  const provided = new Set(facts.flatMap(({ facts }) => facts?.provides ?? []));
  return facts.flatMap(({ statement, facts }) => {
    const routine = unwrap(statement.node, "CreateFunctionStmt");
    if (routine === undefined || facts === undefined) {
      return [];
    }
    const options = defElems(routine.options);
    const setsSearchPath = options.some(
      ({ name, arg }) =>
        name === "set" &&
        unwrap(arg, "VariableSetStmt")?.name === "search_path",
    );
    const language = defElemString(
      options.find((option) => option.name === "language")?.arg,
    )?.toLowerCase();
    if (setsSearchPath || routine.sql_body !== undefined) {
      return [];
    }
    const trees =
      language === "plpgsql"
        ? plpgsqlTrees(statement)
        : language === "sql"
          ? sqlBodyTrees(options.find((option) => option.name === "as")?.arg)
          : [];
    const names = [
      ...new Set(
        trees
          .flatMap(unqualifiedReferences)
          .filter(({ key }) => provided.has(key))
          .map(({ name }) => name),
      ),
    ];
    if (names.length === 0) {
      return [];
    }
    const qualify = `qualify ${names.length === 1 ? "it" : "them"} (${managedSchema}.${names[0]})`;
    const setSearchPath = `add SET search_path = ${managedSchema}, pg_catalog to the ${facts.kind}`;
    const fixes =
      language === "sql"
        ? `${qualify}, ${setSearchPath}, or write the body as BEGIN ATOMIC`
        : `${qualify} or ${setSearchPath}`;
    return [
      {
        file: statement.file,
        line: statement.line,
        routine: facts.identity,
        names,
        message: `${facts.identity} names ${listed(names)} without a schema in its body, which PostgreSQL resolves with the caller's search_path when it runs, and a search_path without ${managedSchema} (the default) makes every call fail: ${fixes}`,
      },
    ];
  });
}

/** The parsed SQL of each expression and statement in a PL/pgSQL body. */
function plpgsqlTrees(statement: ParsedStatement): unknown[] {
  const trees: unknown[] = [];
  try {
    walk(parsePlPgSQLSync(statement.text), (object) => {
      const expression = object.PLpgSQL_expr;
      if (isObject(expression) && typeof expression.query === "string") {
        trees.push(
          parseEmbedded(expression.query, Number(expression.parseMode ?? 0)),
        );
      }
    });
  } catch {
    // The rules report body syntax errors.
  }
  return trees.filter((tree) => tree !== undefined);
}

function sqlBodyTrees(body: unknown): unknown[] {
  try {
    return [parseSync(defElemString(body) ?? "")];
  } catch {
    return [];
  }
}
