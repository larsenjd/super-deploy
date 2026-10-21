// Adoption's CREATE TABLEs declare whole tables. The differ splits some
// out into ALTER TABLEs after the CREATE TABLE: columns whose type or
// default needs an object it creates later (a domain, a function), stored
// generated columns, an inheritance child's own columns
// (`ALTER TABLE ... ADD COLUMN`), and storage parameters
// (`ALTER TABLE ... SET (...)`). The desired schema refuses those ALTER
// TABLEs, so adoption folds each single-command one back into its table's
// CREATE TABLE: a column into the column list, in the target's column
// order; storage parameters into `WITH (...)`, where the desired-schema
// rules report them for what they are. Desired-schema ordering then puts
// each table after the domains and functions it uses.
//
// Folding edits the differ's text, cut at the parser's token offsets (UTF-8
// bytes), so quoted names, string literals and parentheses inside
// expressions are never split. A CREATE TABLE whose column list can't be
// found (`PARTITION OF`, `OF type`) is left alone, with its ALTER TABLEs.
import { scanSync } from "libpg-query";
import {
  alterTableCommands,
  closingParen,
  type Json,
  list,
  nesting,
  rangeVar,
  type Token,
  unwrap,
} from "./syntax-tree.ts";

/** A generated statement as adoption keeps it: its text and syntax tree. */
export interface KeptStatement {
  readonly sql: string;
  readonly type: string;
  readonly node: Json;
}

/**
 * The statements with every `ALTER TABLE t ADD COLUMN` and
 * `ALTER TABLE t SET (...)` folded into the CREATE TABLE of `t` among
 * them. `columnOrder`: each table's column names in the target's order;
 * columns of a table not in it stay in the differ's order. Needs the WASM
 * module loaded (parseSqlFile does that).
 */
export function foldTableAlters<S extends KeptStatement>(
  statements: readonly S[],
  columnOrder: Readonly<Record<string, readonly string[]>>,
): S[] {
  const foldsOf = new Map<string, Folds>();
  for (const statement of statements) {
    const table = createdTable(statement);
    if (table !== undefined) {
      foldsOf.set(table, { columns: [], options: [] });
    }
  }
  const alters = new Map<S, string>();
  for (const statement of statements) {
    const alter = tableAlter(statement);
    const folds = alter === undefined ? undefined : foldsOf.get(alter.table);
    if (alter !== undefined && folds !== undefined) {
      if (alter.column !== undefined) {
        folds.columns.push(alter.column);
      } else if (alter.options !== undefined) {
        folds.options.push(alter.options);
      }
      alters.set(statement, alter.table);
    }
  }
  const folded = new Map<string, string>();
  for (const statement of statements) {
    const table = createdTable(statement);
    const folds = table === undefined ? undefined : foldsOf.get(table);
    if (
      table !== undefined &&
      folds !== undefined &&
      (folds.columns.length > 0 || folds.options.length > 0)
    ) {
      const sql = foldedCreate(statement, folds, columnOrder[table]);
      if (sql !== undefined) {
        folded.set(table, sql);
      }
    }
  }
  // An ALTER stays when its CREATE TABLE couldn't take it.
  return statements.flatMap((statement) => {
    const altered = alters.get(statement);
    if (altered !== undefined && folded.has(altered)) {
      return [];
    }
    const table = createdTable(statement);
    const sql = table === undefined ? undefined : folded.get(table);
    return [sql === undefined ? statement : { ...statement, sql }];
  });
}

/** The table a CREATE TABLE creates, or undefined. */
function createdTable(statement: KeptStatement): string | undefined {
  return statement.type === "CreateStmt"
    ? relationName(statement.node.relation)
    : undefined;
}

interface Column {
  readonly name: string;
  readonly text: string;
}

interface Folds {
  readonly columns: Column[];
  /** Each ALTER's storage parameters, as written inside its `SET (...)`. */
  readonly options: string[];
}

/** A single-command ADD COLUMN or SET (...) of a table, or undefined. */
function tableAlter(
  statement: KeptStatement,
): { table: string; column?: Column; options?: string } | undefined {
  const { sql, type, node } = statement;
  const commands = alterTableCommands(node);
  const table = relationName(node.relation);
  if (
    type !== "AlterTableStmt" ||
    node.objtype !== "OBJECT_TABLE" ||
    commands.length !== 1 ||
    table === undefined
  ) {
    return undefined;
  }
  const [command = {}] = commands;
  const bytes = Buffer.from(sql, "utf8");
  const tokens = scanSync(sql).tokens;
  const column = unwrap(command.def, "ColumnDef");
  if (
    command.subtype === "AT_AddColumn" &&
    command.missing_ok !== true &&
    column !== undefined &&
    typeof column.colname === "string" &&
    typeof column.location === "number"
  ) {
    // To its last token: no semicolon, no comment after it.
    const last = tokens.findLast(
      (token) => token.text !== ";" && !token.tokenName.endsWith("_COMMENT"),
    );
    const text = bytes.subarray(column.location, last?.end).toString("utf8");
    return { table, column: { name: column.colname, text } };
  }
  if (command.subtype === "AT_SetRelOptions") {
    const set = tokens.findIndex(
      (token, index) =>
        token.text.toUpperCase() === "SET" && tokens[index + 1]?.text === "(",
    );
    const close = set < 0 ? undefined : closingParen(tokens, set + 1);
    if (close !== undefined) {
      const open = tokens[set + 1]?.end ?? 0;
      const options = bytes.subarray(open, tokens[close]?.start).toString();
      return { table, options: options.trim() };
    }
  }
  return undefined;
}

/** The CREATE TABLE's text with `folds` in it, or undefined if it can't be. */
function foldedCreate(
  { sql, node }: KeptStatement,
  folds: Folds,
  order: readonly string[] | undefined,
): string | undefined {
  const bytes = Buffer.from(sql, "utf8");
  const tokens = scanSync(sql).tokens;
  const relation = rangeVar(node.relation);
  let open = tokens.findIndex((token) => token.start === relation.location);
  while (tokens[open + 1]?.text === ".") {
    open += 2;
  }
  open += 1;
  const close = tokens[open]?.text === "(" ? closingParen(tokens, open) : -1;
  if (open <= 0 || close === undefined || close < 0) {
    return undefined;
  }
  const elements = topLevelItems(tokens, open, close)
    .map((range) =>
      bytes.subarray(range.start, range.end).toString("utf8").trim(),
    )
    .filter((element) => element !== "");
  const nodes = list(node.tableElts);
  if (elements.length !== nodes.length) {
    return undefined;
  }
  const declared: Column[] = [];
  const constraints: string[] = [];
  for (const [index, element] of nodes.entries()) {
    const column = unwrap(element, "ColumnDef");
    const text = elements[index] as string;
    if (typeof column?.colname === "string") {
      declared.push({ name: column.colname, text });
    } else {
      constraints.push(text);
    }
  }
  const position = (column: Column): number => {
    const at = order?.indexOf(column.name) ?? -1;
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const columns = [...declared, ...folds.columns].sort(
    (a, b) => position(a) - position(b),
  );
  const items = [...columns.map((column) => column.text), ...constraints];
  const before = bytes.subarray(0, tokens[open]?.end).toString("utf8");
  const after = bytes.subarray(tokens[close]?.end).toString("utf8");
  return `${before}${items.join(", ")})${withOptions(after, folds.options)}`;
}

/**
 * The text after the column list's closing parenthesis, with storage
 * parameters added to its `WITH (...)`, or a `WITH (...)` added before
 * `TABLESPACE` (else at the end) when it has none.
 */
function withOptions(after: string, options: readonly string[]): string {
  if (options.length === 0) {
    return after;
  }
  const bytes = Buffer.from(after, "utf8");
  const tokens = scanSync(after).tokens;
  const at = (offset: number | undefined): [string, string] => [
    bytes.subarray(0, offset).toString("utf8"),
    bytes.subarray(offset).toString("utf8"),
  ];
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    const word = token.text.toUpperCase();
    depth += nesting(token);
    if (depth === 0 && word === "WITH" && tokens[index + 1]?.text === "(") {
      const close = tokens[closingParen(tokens, index + 1) ?? -1];
      if (close !== undefined) {
        const [head, tail] = at(close.start);
        return `${head}, ${options.join(", ")}${tail}`;
      }
    } else if (depth === 0 && word === "TABLESPACE") {
      const [head, tail] = at(token.start);
      return `${head}WITH (${options.join(", ")}) ${tail}`;
    }
  }
  const end = tokens.at(-1)?.text === ";" ? tokens.at(-1)?.start : bytes.length;
  const [head, tail] = at(end);
  return `${head.trimEnd()} WITH (${options.join(", ")})${tail}`;
}

/** Byte ranges of the comma-separated items between `open` and `close`. */
function topLevelItems(
  tokens: readonly Token[],
  open: number,
  close: number,
): { start: number; end: number }[] {
  const items: { start: number; end: number }[] = [];
  let depth = 0;
  let start = tokens[open]?.end ?? 0;
  for (let index = open + 1; index < close; index += 1) {
    const token = tokens[index] as Token;
    depth += nesting(token);
    if (depth === 0 && token.text === ",") {
      items.push({ start, end: token.start });
      start = token.end;
    }
  }
  return [...items, { start, end: tokens[close]?.start ?? start }];
}

/** A RangeVar's table name, or undefined. */
function relationName(value: unknown): string | undefined {
  const { relname } = rangeVar(value);
  return typeof relname === "string" ? relname : undefined;
}
