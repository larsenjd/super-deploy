# Deploy-time SQL is checked against an allowlist using PostgreSQL's own parser

Every SQL file that can run during a deployment (generated schema changes as well as hand-written scripts) is parsed with `libpg_query`, PostgreSQL's own parser compiled to WASM, and each statement must match an explicitly approved statement type and options. We chose an allowlist over a denylist because a denylist fails open: any syntax we didn't think of, including syntax added by a later PostgreSQL version, would be let through. Checking generated schema changes too means a differ bug cannot bypass the rules.

## Consequences

- The desired schema has its own, narrower rule set: only `CREATE`, `COMMENT` and `GRANT` statements for supported object types, plus `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` and `ALTER TABLE ... ADD CONSTRAINT` (needed for row-level security and circular foreign keys).
- Things the parser cannot see (code inside extensions, event triggers) need other backstops.
