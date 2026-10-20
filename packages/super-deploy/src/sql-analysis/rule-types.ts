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
}
