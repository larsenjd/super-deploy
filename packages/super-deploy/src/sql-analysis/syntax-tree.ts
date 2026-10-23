// Small helpers for reading libpg-query's JSON syntax trees, which omit
// default values (false, 0, "", empty lists) and wrap most nodes as
// `{ NodeType: {...} }` but embed some unwrapped (e.g. `CreateStmt.relation`).

import type { AlterTableCmd } from "@pgsql/types";
import type { ParsedStatement } from "./parse.ts";

export type Json = { readonly [key: string]: unknown };

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The inner object of a wrapped node `{ [type]: inner }`, if it is one,
 * typed as `T` (e.g. `unwrap<Constraint>(item, "Constraint")`).
 */
export function unwrap<T = Json>(node: unknown, type: string): T | undefined {
  if (!isObject(node)) {
    return undefined;
  }
  const inner = node[type];
  return isObject(inner) ? (inner as T) : undefined;
}

/** A parsed statement's own node, e.g. the inner `AlterTableStmt`. */
export function statementBody(statement: ParsedStatement): Json {
  const body = (statement.node as unknown as Json)[statement.nodeType];
  return isObject(body) ? body : {};
}

/** A RangeVar, wrapped or not (a statement's own `relation` isn't). */
export function rangeVar(value: unknown): Json {
  return unwrap(value, "RangeVar") ?? (isObject(value) ? value : {});
}

/** The subcommands of an `AlterTableStmt` body. */
export function alterTableCommands(body: Json): AlterTableCmd[] {
  return list(body.cmds).flatMap((item) => {
    const cmd = unwrap<AlterTableCmd>(item, "AlterTableCmd");
    return cmd === undefined ? [] : [cmd];
  });
}

/** The schema of a dotted name with at least `parts` parts (its first part). */
export function schemaQualifier(
  names: readonly string[],
  parts: number,
): string | undefined {
  return names.length >= parts ? names[0] : undefined;
}

/** The single key of a wrapped node, e.g. `CreateStmt`. */
export function nodeType(node: unknown): string | undefined {
  return isObject(node) ? Object.keys(node)[0] : undefined;
}

/** `[{String: {sval}}...]` (also wrapped in `{List: {items}}`) as strings. */
export function stringList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : (unwrap(value, "List")?.items as unknown[] | undefined);
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((item) => {
    const sval = unwrap(item, "String")?.sval;
    return typeof sval === "string" ? [sval] : [];
  });
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Calls `visit` on every object in the tree, depth first, parents first. */
export function walk(node: unknown, visit: (object: Json) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visit);
    }
  } else if (isObject(node)) {
    visit(node);
    for (const value of Object.values(node)) {
      walk(value, visit);
    }
  }
}

/** A `DefElem` list (`options`) as name → argument. */
export function defElems(options: unknown): { name: string; arg: unknown }[] {
  return list(options).flatMap((option) => {
    const element = unwrap(option, "DefElem");
    return typeof element?.defname === "string"
      ? [{ name: element.defname, arg: element.arg }]
      : [];
  });
}

/** A DefElem argument that is a single string (`String` or a one-item list). */
export function defElemString(arg: unknown): string | undefined {
  const sval = unwrap(arg, "String")?.sval;
  if (typeof sval === "string") {
    return sval;
  }
  const items = stringList(arg);
  return items.length === 1 ? items[0] : undefined;
}

/** `{ Type: body }` as `["Type", body]`, or undefined if `value` is not a wrapped node. */
export function wrapped(value: unknown): [string, Json] | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  const [type] = keys;
  if (keys.length !== 1 || type === undefined || !/^[A-Z]/.test(type)) {
    return undefined;
  }
  const body = value[type];
  return isObject(body) ? [type, body] : undefined;
}

export interface NodeVisit {
  /** Node type, e.g. `FuncCall`; unwrapped RangeVar and TypeName nodes are recognised by shape. */
  readonly type: string;
  readonly node: Json;
  /** The field this node was found in (`relation`, `sortClause`, ...). */
  readonly key: string | undefined;
}

/**
 * Like `walk`, but reports typed nodes only: wrapped nodes by their type, and
 * the unwrapped RangeVar and TypeName nodes some fields embed (e.g.
 * `InsertStmt.relation`) by their shape. Parents come before children;
 * returning `false` skips a node's children.
 */
export function walkNodes(
  root: unknown,
  visit: (visit: NodeVisit) => boolean | undefined,
): void {
  const descend = (value: unknown, key: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        descend(item, key);
      }
      return;
    }
    if (!isObject(value)) {
      return;
    }
    const node = wrapped(value);
    if (node !== undefined) {
      if (visit({ type: node[0], node: node[1], key }) !== false) {
        children(node[1]);
      }
      return;
    }
    const shape =
      "relname" in value && "relpersistence" in value
        ? "RangeVar"
        : "names" in value && "typemod" in value
          ? "TypeName"
          : undefined;
    if (
      shape !== undefined &&
      visit({ type: shape, node: value, key }) === false
    ) {
      return;
    }
    children(value);
  };
  const children = (body: Json): void => {
    for (const [key, child] of Object.entries(body)) {
      descend(child, key);
    }
  };
  descend(root, undefined);
}

/** A token as libpg-query's `scanSync` gives it: UTF-8 byte offsets in the text scanned. */
export interface Token {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** e.g. `SQL_COMMENT`, `IDENT`, `ASCII_40` for `(`. */
  readonly tokenName: string;
}

/** How a token changes the parenthesis depth. */
export function nesting(token: Token | undefined): number {
  return token?.text === "(" ? 1 : token?.text === ")" ? -1 : 0;
}

/** The index of the token closing the parenthesis at `open`. */
export function closingParen(
  tokens: readonly Token[],
  open: number,
): number | undefined {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    depth += nesting(tokens[index]);
    if (depth === 0) {
      return index;
    }
  }
  return undefined;
}
