# Deploy-time SQL is checked against an allowlist using PostgreSQL's own parser

Every SQL file that can run during a deployment (generated schema changes as well as hand-written scripts) is parsed with `libpg_query`, PostgreSQL's own parser compiled to WASM, and each statement must match an explicitly approved statement type and options. We chose an allowlist over a denylist because a denylist fails open: any syntax we didn't think of, including syntax added by a later PostgreSQL version, would be let through. Checking generated schema changes too means a differ bug cannot bypass the rules.

## Consequences

- The desired schema has its own, narrower rule set: only `CREATE` and `COMMENT` statements for supported object types, plus `ALTER TABLE ... ADD CONSTRAINT` (needed for circular foreign keys). `GRANT`, `REVOKE` and row-level security were allowed until ADR-0006 put privileges outside the system.
- The desired schema defines each object exactly once and always loads into an empty schema. `IF NOT EXISTS` and `OR REPLACE` are accepted and change nothing: ordering's `duplicate-object` rule (ADR-0004) refuses a second definition of an object whatever its clauses, so they cannot hide one. They were refused until a real-world schema, written to be re-runnable, showed the refusal cost more than it protected.
- Things the parser cannot see (code inside extensions, event triggers) need other backstops.
