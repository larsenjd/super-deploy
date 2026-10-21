// Ordering (ADR-0004): given the desired-schema files, the statements in the
// order to load them, or errors (unknown references, cycles, order-dependent
// constructs) with file and line, all found before anything loads. It also
// refuses a comment on a view's column (QA 127): only the whole desired
// schema tells a view's column from a table's.
//
// Statements, not files, are ordered: by dependencies first, then object-kind
// priority, then object identity, then a hash of the statement text. File
// names and statement positions never decide the order; they only label
// byte-identical duplicates, whose relative order cannot matter.
import { createHash } from "node:crypto";
import { viewColumnCommentFinding } from "./desired-schema-rules.ts";
import {
  lineAtLocation,
  type ParsedStatement,
  parseSqlFile,
  type SqlFile,
} from "./parse.ts";
import {
  pgCatalogFunctions,
  pgCatalogRelations,
  pgCatalogTypes,
} from "./pg-catalog-names.ts";
import {
  decorationKinds,
  type Reference,
  type StatementFacts,
  type StatementKind,
  statementFacts,
} from "./references.ts";
import type { RuleViolation } from "./rules.ts";

export interface OrderingResult {
  /** Every statement once, in load order; empty when there are errors. */
  readonly statements: readonly ParsedStatement[];
  readonly errors: readonly RuleViolation[];
}

export interface OrderingOptions {
  /** The managed schema (default `public`): `<managedSchema>.x` names the desired schema's own x. */
  managedSchema?: string;
}

export async function orderDesiredSchema(
  files: readonly SqlFile[],
  options: OrderingOptions = {},
): Promise<OrderingResult> {
  const statements: ParsedStatement[] = [];
  const errors: RuleViolation[] = [];
  // Files are read in path order only so statement ids are stable; ids never decide the order.
  for (const file of [...files].sort((a, b) => compareText(a.path, b.path))) {
    const parsed = await parseSqlFile(file);
    if (parsed.ok) {
      statements.push(...parsed.statements);
    } else {
      errors.push(parsed.violation);
    }
  }
  if (errors.length > 0) {
    return { statements: [], errors };
  }
  const graph = analyse(statements, options.managedSchema ?? "public");
  if (graph.errors.length > 0) {
    return { statements: [], errors: sortViolations(graph.errors) };
  }
  const sorted = topologicalOrder(graph, defaultTieBreak);
  if (sorted.cycle !== undefined) {
    return { statements: [], errors: [cycleViolation(sorted.cycle)] };
  }
  return { statements: sorted.order.map((node) => node.statement), errors: [] };
}

/**
 * The same statements (as returned by orderDesiredSchema) in a different
 * valid order, for the order-independence check: kind priority is ignored
 * and identity ties are reversed, which flips as many independent pairs as a
 * single order can.
 */
export function alternativeOrder(
  statements: readonly ParsedStatement[],
  options: OrderingOptions = {},
): readonly ParsedStatement[] {
  const graph = analyse(statements, options.managedSchema ?? "public");
  const sorted = topologicalOrder(graph, alternativeTieBreak);
  if (graph.errors.length > 0 || sorted.cycle !== undefined) {
    throw new Error(
      "alternativeOrder needs statements that orderDesiredSchema accepted",
    );
  }
  return sorted.order.map((node) => node.statement);
}

const priority: Record<StatementKind, number> = {
  extension: 0,
  type: 10,
  domain: 11,
  table: 20,
  function: 30,
  procedure: 31,
  view: 40,
  "materialized view": 41,
  constraint: 50,
  index: 60,
  trigger: 70,
  comment: 80,
};

interface GraphNode {
  readonly id: number;
  readonly statement: ParsedStatement;
  readonly facts: StatementFacts;
  /** 0 = structure, 1 = decorations (always after every structural statement). */
  readonly phase: number;
  readonly priority: number;
  readonly hash: string;
}

interface Graph {
  readonly nodes: readonly GraphNode[];
  /** Successors by node id: `from` must load before each of `to`. */
  readonly successors: readonly (readonly number[])[];
  readonly predecessors: readonly (readonly number[])[];
  readonly errors: RuleViolation[];
}

/** A violation of `rule` by `statement`, at the parser's `location` in it if given. */
function violationAt(
  statement: ParsedStatement,
  rule: string,
  message: string,
  location?: number,
): RuleViolation {
  return {
    file: statement.file,
    line:
      location === undefined
        ? statement.line
        : lineAtLocation(statement, location),
    statement: statement.text,
    rule,
    message,
  };
}

/**
 * Ordering's checks of one statement on its own: the problems in its facts
 * (unnamed constraints and indexes, ...), or `unorderable-statement`.
 * Ordering runs them on every statement; the desired-schema analysis also
 * runs them alone when the rules refused something, which the rest of
 * ordering (references, duplicates, cycles) can't be trusted around.
 */
export function statementProblems(
  statement: ParsedStatement,
  managedSchema: string,
): { facts: StatementFacts | undefined; problems: RuleViolation[] } {
  const facts = statementFacts(statement.node, managedSchema);
  return {
    facts,
    problems:
      facts === undefined
        ? [
            violationAt(
              statement,
              "unorderable-statement",
              `super-deploy can't order this ${statement.nodeType} statement, so it can't be part of the desired schema`,
            ),
          ]
        : facts.problems.map((problem) =>
            violationAt(
              statement,
              problem.rule,
              problem.message,
              problem.location,
            ),
          ),
  };
}

function analyse(
  statements: readonly ParsedStatement[],
  managedSchema: string,
): Graph {
  const errors: RuleViolation[] = [];
  const violation = (
    statement: ParsedStatement,
    rule: string,
    message: string,
  ) => {
    errors.push(violationAt(statement, rule, message));
  };

  const nodes: GraphNode[] = [];
  for (const statement of statements) {
    const { facts, problems } = statementProblems(statement, managedSchema);
    errors.push(...problems);
    if (facts === undefined) {
      continue;
    }
    nodes.push({
      id: nodes.length,
      statement,
      facts,
      phase: decorationKinds.has(facts.kind) ? 1 : 0,
      priority: priority[facts.kind],
      hash: createHash("sha256")
        .update(statement.text.replace(/\s+/g, " "))
        .digest("hex"),
    });
  }
  const where = (node: GraphNode) =>
    `${node.statement.file}:${node.statement.line}`;

  const producers = new Map<string, number[]>();
  const produce = (key: string, id: number) => {
    const list = producers.get(key);
    if (list === undefined) {
      producers.set(key, [id]);
    } else if (!list.includes(id)) {
      list.push(id);
    }
  };
  for (const node of nodes) {
    for (const key of node.facts.provides) {
      produce(key, node.id);
    }
  }

  // Duplicates: two statements creating the same object.
  const reported = new Set<string>();
  /** `a,b` for statements already reported as creating the same object. */
  const duplicates = new Set<string>();
  const duplicate = (ids: readonly number[], what: string) => {
    const group = ids.map((id) => nodes[id] as GraphNode);
    const signature = ids.join(",");
    if (reported.has(signature)) {
      return;
    }
    reported.add(signature);
    for (const a of ids) {
      for (const b of ids) {
        duplicates.add(`${a},${b}`);
      }
    }
    const [, second] = [...group].sort(compareLocation);
    if (second !== undefined) {
      violation(
        second.statement,
        "duplicate-object",
        `${what} is created more than once: ${group
          .sort(compareLocation)
          .map((node) => `${node.facts.identity} (${where(node)})`)
          .join(", ")}`,
      );
    }
  };
  const duplicateNamespaces: Record<string, string> = {
    rel: "Relation",
    type: "Type",
    con: "Constraint",
    domcon: "Domain constraint",
    trigger: "Trigger",
  };
  for (const [key, ids] of producers) {
    const namespace = key.slice(0, key.indexOf(":"));
    const label = duplicateNamespaces[namespace];
    if (label !== undefined && ids.length > 1) {
      duplicate(ids, `${label} ${key.slice(namespace.length + 1)}`);
    }
  }
  const identities = new Map<string, number[]>();
  for (const node of nodes) {
    const routine = node.facts.routine;
    const key =
      routine !== undefined
        ? `routine ${routine.name}(${routine.arguments.join(",")})`
        : node.facts.kind === "comment"
          ? node.facts.identity
          : undefined;
    if (key !== undefined) {
      identities.set(key, [...(identities.get(key) ?? []), node.id]);
    }
  }
  for (const [key, ids] of identities) {
    if (ids.length > 1) {
      duplicate(
        ids,
        key.startsWith("routine ") ? `Routine ${key.slice(8)}` : `The ${key}`,
      );
    }
  }

  // Generated constraint names that collide: which object gets the plain name depends on load order.
  const constraintNames = new Map<string, number[]>();
  for (const node of nodes) {
    for (const name of [
      ...node.facts.constraintNames,
      ...node.facts.generatedConstraintNames.map((generated) => generated.name),
    ]) {
      constraintNames.set(name, [
        ...(constraintNames.get(name) ?? []),
        node.id,
      ]);
    }
  }
  for (const node of nodes) {
    for (const generated of node.facts.generatedConstraintNames) {
      const users = constraintNames.get(generated.name) ?? [];
      const others = users
        .filter((id) => id !== node.id && !duplicates.has(`${node.id},${id}`))
        .map((id) => nodes[id] as GraphNode);
      const sameStatement = users.filter((id) => id === node.id).length > 1;
      if (others.length > 0 || sameStatement) {
        violation(
          node.statement,
          "generated-name-collision",
          `PostgreSQL names ${generated.what} ${generated.name}, which ${others.length > 0 ? others.map((other) => `${other.facts.identity} (${where(other)})`).join(", ") : "another constraint in the same statement"} also uses; name the constraint explicitly`,
        );
      }
    }
  }

  // Foreign keys whose referenced columns have more than one unique key: PostgreSQL uses the first it finds.
  for (const node of nodes) {
    for (const foreign of node.facts.foreignKeys) {
      if (foreign.columns.length === 0) {
        continue; // References the primary key itself.
      }
      const columns = [...foreign.columns].sort().join(",");
      const keys = new Set<string>();
      for (const id of producers.get(`uniq:${foreign.table}`) ?? []) {
        for (const key of (nodes[id] as GraphNode).facts.uniqueKeys) {
          if (
            key.table === foreign.table &&
            key.columns.join(",") === columns
          ) {
            keys.add(key.source);
          }
        }
      }
      if (keys.size > 1) {
        violation(
          node.statement,
          "foreign-key-ambiguous-unique-key",
          `Foreign key ${foreign.constraint || "(unnamed)"} references ${foreign.table} (${foreign.columns.join(", ")}), which has more than one unique key on those columns (${[...keys].sort(compareText).join(", ")}); PostgreSQL would use whichever it finds first, so keep only one`,
        );
      }
    }
  }

  // Function calls in column syntax: `c.f` may mean f(c), a reference ordering can't see.
  const projections = new Set<string>();
  const compositeTypes = new Set(
    nodes
      .filter((node) =>
        ["table", "view", "materialized view", "type"].includes(
          node.facts.kind,
        ),
      )
      .flatMap((node) =>
        node.facts.provides
          .filter((key) => key.startsWith("type:"))
          .map((key) => key.slice(5)),
      ),
  );
  for (const node of nodes) {
    const routine = node.facts.routine;
    const [argument] = routine?.arguments ?? [];
    if (
      routine !== undefined &&
      routine.arguments.length === 1 &&
      argument !== undefined &&
      (argument === "record" ||
        compositeTypes.has(
          argument.startsWith(`${managedSchema}.`)
            ? argument.slice(managedSchema.length + 1)
            : argument,
        ))
    ) {
      projections.add(routine.name);
    }
  }
  for (const node of nodes) {
    for (const name of new Set(node.facts.fieldSelections)) {
      if (projections.has(name)) {
        violation(
          node.statement,
          "function-call-in-column-syntax",
          `${node.facts.identity} selects field ${name}, which may call function ${name}() in column syntax (x.${name} meaning ${name}(x)); write ${name}(x) instead, or rename the column or the function`,
        );
      }
    }
  }

  // Comments on a view's columns: pg-delta never generates them (QA 127).
  for (const node of nodes) {
    const relation = node.facts.commentedColumnOf;
    const view = (relation === undefined ? [] : (producers.get(relation) ?? []))
      .map((id) => nodes[id] as GraphNode)
      .find(({ facts }) => ["view", "materialized view"].includes(facts.kind));
    if (view !== undefined) {
      const finding = viewColumnCommentFinding(
        `; ${view.facts.identity} is one. Leave the comment out, or describe the column in the comment on the ${view.facts.kind}`,
      );
      violation(node.statement, finding.rule, finding.message);
    }
  }

  // Edges, and references nothing provides.
  const successors: number[][] = nodes.map(() => []);
  const predecessors: number[][] = nodes.map(() => []);
  const edge = (from: number, to: number) => {
    if (from !== to && !(successors[from] as number[]).includes(to)) {
      (successors[from] as number[]).push(to);
      (predecessors[to] as number[]).push(from);
    }
  };
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const reference of node.facts.references) {
      const unique = `${reference.key}|${reference.managedOnly}`;
      if (seen.has(unique)) {
        continue;
      }
      seen.add(unique);
      const found = producers.get(reference.key) ?? [];
      for (const id of found) {
        edge(id, node.id);
      }
      if (found.length === 0 && !builtIn(reference)) {
        violation(
          node.statement,
          "unknown-reference",
          `${node.facts.identity} references ${reference.kind} ${reference.name}, which the desired schema doesn't create${reference.managedOnly ? "" : " and pg_catalog doesn't have"}`,
        );
      }
    }
    for (const key of node.facts.waitsFor) {
      for (const id of producers.get(key) ?? []) {
        edge(id, node.id);
      }
    }
  }
  return { nodes, successors, predecessors, errors };
}

function builtIn(reference: Reference): boolean {
  if (reference.managedOnly) {
    return false;
  }
  const name = reference.key.slice(reference.key.indexOf(":") + 1);
  switch (reference.kind) {
    case "relation":
      return pgCatalogRelations.has(name);
    case "type":
      return pgCatalogTypes.has(name);
    case "function":
      return pgCatalogFunctions.has(name);
    default:
      return false;
  }
}

type TieBreak = (a: GraphNode, b: GraphNode) => number;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareContent(a: GraphNode, b: GraphNode): number {
  return (
    compareText(a.facts.identity, b.facts.identity) ||
    compareText(a.hash, b.hash) ||
    compareText(a.statement.text, b.statement.text)
  );
}

function compareLocation(a: GraphNode, b: GraphNode): number {
  return (
    compareText(a.statement.file, b.statement.file) ||
    a.statement.line - b.statement.line ||
    a.statement.offset - b.statement.offset
  );
}

const defaultTieBreak: TieBreak = (a, b) =>
  a.phase - b.phase ||
  a.priority - b.priority ||
  compareContent(a, b) ||
  compareLocation(a, b);

const alternativeTieBreak: TieBreak = (a, b) =>
  a.phase - b.phase || compareContent(b, a) || compareLocation(b, a);

/** Kahn's algorithm, always taking the smallest ready statement by the tie-break. */
function topologicalOrder(
  graph: Graph,
  compare: TieBreak,
): { order: GraphNode[]; cycle?: GraphNode[] } {
  const waiting = graph.nodes.map(
    (node) => (graph.predecessors[node.id] as number[]).length,
  );
  const ready = new Heap<GraphNode>(compare);
  for (const node of graph.nodes) {
    if (waiting[node.id] === 0) {
      ready.push(node);
    }
  }
  const order: GraphNode[] = [];
  for (let node = ready.pop(); node !== undefined; node = ready.pop()) {
    order.push(node);
    for (const next of graph.successors[node.id] as number[]) {
      waiting[next] = (waiting[next] as number) - 1;
      if (waiting[next] === 0) {
        ready.push(graph.nodes[next] as GraphNode);
      }
    }
  }
  if (order.length === graph.nodes.length) {
    return { order };
  }
  return { order, cycle: findCycle(graph, waiting, compare) };
}

/** One cycle among the statements Kahn's algorithm couldn't place, in load-dependency order. */
function findCycle(
  graph: Graph,
  waiting: readonly number[],
  compare: TieBreak,
): GraphNode[] {
  const left = graph.nodes.filter((node) => (waiting[node.id] as number) > 0);
  const remaining = new Set(left.map((node) => node.id));
  const start = [...left].sort(compare)[0] as GraphNode;
  // Walk predecessors (every remaining node has one that remains) until a node repeats.
  const path: number[] = [];
  let current = start.id;
  while (!path.includes(current)) {
    path.push(current);
    const previous = (graph.predecessors[current] as number[])
      .filter((id) => remaining.has(id))
      .map((id) => graph.nodes[id] as GraphNode)
      .sort(compare)[0] as GraphNode;
    current = previous.id;
  }
  return path
    .slice(path.indexOf(current))
    .reverse()
    .map((id) => graph.nodes[id] as GraphNode);
}

function cycleViolation(cycle: GraphNode[]): RuleViolation {
  const [first] = [...cycle].sort(compareLocation) as [GraphNode];
  const rotated = [
    ...cycle.slice(cycle.indexOf(first)),
    ...cycle.slice(0, cycle.indexOf(first)),
  ];
  const label = (node: GraphNode) =>
    `${node.facts.identity} (${node.statement.file}:${node.statement.line})`;
  const inlineForeignKey = rotated.some(
    (node) => node.facts.kind === "table" && node.facts.foreignKeys.length > 0,
  );
  const tip = inlineForeignKey
    ? "move one foreign key out of CREATE TABLE into ALTER TABLE ... ADD CONSTRAINT"
    : "move the check or default that calls the function into ALTER TABLE ... ADD CONSTRAINT, or make the function PL/pgSQL (resolved when it runs)";
  return {
    file: first.statement.file,
    line: first.statement.line,
    statement: first.statement.text,
    rule: "dependency-cycle",
    message: `Dependency cycle: ${[...rotated, first].map(label).join(" needs ")}. Tip: ${tip}`,
  };
}

function sortViolations(violations: RuleViolation[]): RuleViolation[] {
  return [...violations].sort(
    (a, b) => compareText(a.file, b.file) || a.line - b.line,
  );
}

/** A binary min-heap. */
class Heap<T> {
  private readonly items: T[] = [];

  private readonly compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(items[index] as T, items[parent] as T) >= 0) {
        break;
      }
      [items[index], items[parent]] = [items[parent] as T, items[index] as T];
      index = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (
          left < items.length &&
          this.compare(items[left] as T, items[smallest] as T) < 0
        ) {
          smallest = left;
        }
        if (
          right < items.length &&
          this.compare(items[right] as T, items[smallest] as T) < 0
        ) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        [items[index], items[smallest]] = [
          items[smallest] as T,
          items[index] as T,
        ];
        index = smallest;
      }
    }
    return top;
  }
}
