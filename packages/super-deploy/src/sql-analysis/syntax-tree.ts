// Small helpers for reading libpg-query's JSON syntax trees, which omit
// default values (false, 0, "", empty lists) and wrap most nodes as
// `{ NodeType: {...} }` but embed some unwrapped (e.g. `CreateStmt.relation`).

export type Json = { readonly [key: string]: unknown };

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The inner object of a wrapped node `{ [type]: inner }`, if it is one. */
export function unwrap(node: unknown, type: string): Json | undefined {
  if (!isObject(node)) {
    return undefined;
  }
  const inner = node[type];
  return isObject(inner) ? inner : undefined;
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
