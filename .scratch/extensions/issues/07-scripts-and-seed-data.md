# 07: Scripts and seed data

**What to build:**
- **Calling extension functions.** Pre- and post-migration scripts may call a supported extension's functions at a version the config lists, such as `digest()` and `crypt()` from pgcrypto, or `similarity()` from pg_trgm, for example in a backfill. Calls to the user's own routines stay refused (`user-function-call`).
- **No extension statements.** Pre-migration scripts, post-migration scripts and seed data may contain no extension statement at all: `CREATE`, `ALTER` and `DROP EXTENSION` are refused, `plpgsql` included, which pre-migration scripts may run today. Only the schema change touches extensions.

(Spec: "Deploy-time rules"; user stories 31–33.)

**Blocked by:** 03

**Status:** resolved

- [x] Integration test: a post-migration script that backfills a column with `encode(digest(email, 'sha256'), 'hex')`, with pgcrypto in the desired schema and config, rehearses, finalizes and deploys. The target holds the backfilled values.
- [x] A script calling a function of a supported extension that the config doesn't list (or that the pinned version doesn't provide) is refused as `user-function-call`, as is a call to a routine the desired schema defines.
- [x] `CREATE EXTENSION`, `ALTER EXTENSION` and `DROP EXTENSION` in a pre-migration script, a post-migration script or seed data are refused with a message saying extensions belong in the desired schema. That includes `CREATE EXTENSION plpgsql` in a pre-migration script.
- [x] The README lines and README-coverage rows for these refusals are updated, as are REFINEMENTS "Calling functions and procedures in deploy-time SQL" (already mentions supported extensions) and any test asserting that `plpgsql` is allowed in pre-migration scripts.

## Comments

Extension statements in scripts/seed data are refused under the existing `deploy-time-statement` rule (no new rule id). No README-coverage test exists for deploy-time rules, so no coverage rows were added. Known limits: a function created in a pre-migration script still has its body checked with no extensions allowed; extension-function matching is by name only, like the pg_catalog check.
