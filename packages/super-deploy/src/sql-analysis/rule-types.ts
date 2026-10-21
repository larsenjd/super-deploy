// Types shared by every rule set (desired schema, deploy-time).

/** What the rules need from the project's configuration. */
export interface RuleContext {
  /** Default `public`. */
  readonly managedSchema: string;
  /** Schemas PL/pgSQL bodies may reference. Default none. */
  readonly externalSchemas: readonly string[];
}

export interface RuleFinding {
  readonly rule: string;
  readonly message: string;
  /** Absolute 1-based line, when it isn't the statement's own first line. */
  readonly line?: number;
  /** For `undeclared-schema`: the schema referenced, by which names, and where. */
  readonly reference?: SchemaReference;
}

/**
 * A reference to a schema: in a PL/pgSQL body (resolved when it runs, the
 * one place an external schema may be referenced), or bound at CREATE (a
 * view, default, foreign key, `LANGUAGE sql` body, PL/pgSQL variable
 * declaration, ...).
 */
export interface SchemaReference {
  readonly schema: string;
  /** Each qualified name referencing it, once, e.g. `public.citext`. */
  readonly names: readonly string[];
  readonly where: "plpgsql-body" | "bound-at-create";
}
