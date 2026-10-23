// Every rule the SQL analysis reports, with the category that decides what
// can be done about it. Rule ids are stable: they appear in messages, in
// RuleViolation.rule, and (ticket 10) in override records.
//
// Only "risk" rules can be overridden with `-- OVERRIDE SUPER-DEPLOY REFUSAL:`.
// Everything that breaks or escapes the deploy transaction is "transaction",
// which no marker can override (spec "Override marker").

export type RuleCategory =
  /** The file does not parse. */
  | "syntax"
  /** Cannot run inside, ends, or escapes the deploy transaction. Never overridable. */
  | "transaction"
  /** Dangerous but sometimes justified; overridable (ticket 10). */
  | "risk"
  /** Behaves differently depending on a table's physical column order. */
  | "column-order"
  /** Writes explicit values into identity columns. */
  | "identity"
  /** References something outside the managed schema, or a user-defined function. */
  | "scope"
  /** The statement type is not allowed in this kind of file. */
  | "allowlist"
  /** An object type or feature that super-deploy V1 does not support. */
  | "unsupported"
  /** The desired schema could not be loaded in a deterministic order (ticket 09). */
  | "ordering"
  /** An override marker is malformed, misplaced or overrides nothing. */
  | "override";

export interface RuleDefinition {
  readonly id: string;
  readonly category: RuleCategory;
  /** True only for risk rules (ticket 10's override marker). */
  readonly overridable: boolean;
  readonly summary: string;
}

const definitions = {
  "syntax-error": ["syntax", "The file does not parse as PostgreSQL 18 SQL"],
  // Transaction-breaking: never overridable.
  "not-in-transaction": [
    "transaction",
    "PostgreSQL refuses the statement inside a transaction block",
  ],
  "transaction-control": [
    "transaction",
    "Transaction control would end or alter the deploy transaction",
  ],
  "call-statement": [
    "transaction",
    "CALL can run a procedure that ends the deploy transaction",
  ],
  "do-statement": [
    "transaction",
    "DO blocks are opaque code that can escape the deploy transaction",
  ],
  "escapes-transaction": [
    "transaction",
    "The statement escapes the deploy transaction: a rollback doesn't undo it, it outlives the transaction, or it changes what super-deploy pins for the whole deployment",
  ],
  "temp-table-without-on-commit-drop": [
    "transaction",
    "Temporary objects must be created ON COMMIT DROP so they never outlive the deployment",
  ],
  // Risk rules: the only overridable ones (ticket 10).
  "denylisted-call": [
    "risk",
    "A built-in function whose effects escape the deploy transaction",
  ],
  "plpgsql-dynamic-sql": [
    "risk",
    "EXECUTE in a PL/pgSQL body runs SQL the rules cannot check",
  ],
  // Override markers themselves (ticket 10).
  "override-malformed": [
    "override",
    'An override marker must read exactly "-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>"',
  ],
  "override-without-reason": ["override", "An override marker needs a reason"],
  "override-misplaced": [
    "override",
    "An override marker must be on its own line, directly before one statement",
  ],
  "override-unused": [
    "override",
    "An override marker must override at least one risk rule of its statement",
  ],
  // Scope.
  "outside-managed-schema": [
    "scope",
    "References are limited to the managed schema (plus, where allowed, temporary tables, pg_catalog and declared external schemas)",
  ],
  "undeclared-schema": [
    "scope",
    "A PL/pgSQL body references a schema that is not declared in externalSchemas",
  ],
  "catalog-write": ["scope", "pg_catalog may be read, never changed"],
  "user-function-call": [
    "scope",
    "Deploy-time SQL may call only built-in pg_catalog functions",
  ],
  // Column order and identity columns.
  "insert-without-columns": [
    "column-order",
    "INSERT without a column list depends on column order",
  ],
  "select-star": ["column-order", "* expands in column order"],
  "ordinal-reference": [
    "column-order",
    "ORDER BY, GROUP BY or DISTINCT ON by position depends on column order",
  ],
  "natural-join": [
    "column-order",
    "NATURAL JOIN silently changes when a column is added",
  ],
  "whole-row-reference": [
    "column-order",
    "A whole-row reference depends on column order",
  ],
  "identity-value": [
    "identity",
    "Explicit values into identity columns let the sequence fall behind",
  ],
  // Allowlists and unsupported objects.
  "desired-schema-statement": [
    "allowlist",
    "The statement is not allowed in the desired schema",
  ],
  "deploy-time-statement": [
    "allowlist",
    "The statement is not allowed in this kind of deploy-time file",
  ],
  "unsupported-object": [
    "unsupported",
    "super-deploy V1 does not support this object type or feature",
  ],
  // Desired-schema ordering (ticket 09).
  "unnamed-index": ["ordering", "Every index needs an explicit name"],
  "unnamed-constraint": ["ordering", "Every constraint needs an explicit name"],
  "table-like": ["ordering", "CREATE TABLE ... (LIKE ...) is not supported"],
  "unorderable-statement": [
    "ordering",
    "The statement cannot be placed in the load order",
  ],
  "duplicate-object": ["ordering", "Two statements create the same object"],
  "generated-name-collision": [
    "ordering",
    "A name PostgreSQL would generate collides with another object",
  ],
  "foreign-key-ambiguous-unique-key": [
    "ordering",
    "A foreign key's referenced columns are covered by more than one unique key",
  ],
  "function-call-in-column-syntax": [
    "ordering",
    "A function call written in column syntax",
  ],
  "unknown-reference": ["ordering", "A reference to an unknown object"],
  "dependency-cycle": [
    "ordering",
    "The statements depend on each other in a cycle",
  ],
} as const satisfies Record<string, readonly [RuleCategory, string]>;

export type RuleId = keyof typeof definitions;

export const ruleCatalogue: readonly RuleDefinition[] = Object.entries(
  definitions,
).map(([id, [category, summary]]) => ({
  id,
  category,
  overridable: category === "risk",
  summary,
}));

/** The definition of a rule id, or undefined for an unknown id. */
export function ruleDefinition(id: string): RuleDefinition | undefined {
  return ruleCatalogue.find((rule) => rule.id === id);
}
