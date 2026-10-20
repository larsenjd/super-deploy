# Deploy-time SQL is checked against an allowlist using PostgreSQL's own parser

Every SQL file that can run during a deployment (generated schema changes as well as hand-written scripts) is parsed with `libpg_query`, PostgreSQL's own parser compiled to WASM, and each statement must match an explicitly approved statement type and options. We chose an allowlist over a denylist because a denylist fails open: any syntax we didn't think of, including syntax added by a later PostgreSQL version, would be let through. Checking generated schema changes too means a differ bug cannot bypass the rules.

## Consequences

- The desired schema has its own, narrower rule set: only `CREATE`, `COMMENT` and `GRANT` statements for supported object types, plus `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` and `ALTER TABLE ... ADD CONSTRAINT` (needed for row-level security and circular foreign keys).
- Two grant forms were added after V1's review, because without them grants were incomplete: `GRANT USAGE ON SCHEMA` on the managed schema (object grants in a schema other than `public` are useless without it), and `REVOKE ... FROM PUBLIC` of PostgreSQL's default privileges on objects the desired schema defines (so a `SECURITY DEFINER` function needn't be callable by every role). Both still declare an end state. Every other `REVOKE` stays refused: the desired schema declares what is granted, so the fix is to remove the `GRANT`.
- `IF NOT EXISTS` and `OR REPLACE` are refused permanently, not just in V1: the desired schema defines each object exactly once and always loads into an empty schema, so these clauses could only hide a second definition whose winner depends on load order.
- Things the parser cannot see (code inside extensions, event triggers) need other backstops.
