# 02: One fact per extension, and database-wide extension drift

**What to build:** The catalog comparison sees each extension as one fact, its name, schema and version, never as its member objects. It reads extensions across the target's whole database, not only the managed schema (spec: "Catalog comparison"; GLOSSARY **Drift**).

So, already before the desired schema can declare one, any extension in a target's database is drift, wherever it lives, except `plpgsql`. Examples are `pg_stat_statements` installed in `public` by a DBA, or `citext` in the managed schema.
- `status` reports it once, by name, schema and version.
- `deploy` and `mark` refuse.
- `deploy-draft` refuses, at the API seam with `TerminalRequiredError` as for any guarded command.

Rehearsal comparisons and drift share this, so a later ticket's rehearsals see an extension as one fact too.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] Members of an extension (pg_depend deptype `e`) are left out of every kind of fact the catalog comparison reads, not only the "other" kind: routines, types, relations, columns, comments and dependencies.
- [x] Extensions are read from the whole database as one fact each, with name, schema and version. `plpgsql` in `pg_catalog` is excluded.
- [x] A target with `pg_stat_statements` installed in `public` by the superuser shows one drift line naming the extension, its schema and its version, and `deploy` refuses with the existing drift error.
- [x] A target with `citext` installed in the managed schema by hand shows one drift line, not dozens of functions, operators and types.
- [x] `mark` refuses a target with an unmanaged extension, as it does for other drift.
- [x] The existing adoption refusal for an extension still lists it once (the existing adopt tests for citext keep passing, or change only in wording).
- [x] Headers of the changed modules say that extensions are read database-wide and members never appear.

## Comments

deploy-draft does not check drift by design (see the header of commands/deploy-draft.ts: the target is disposable and a deployed draft makes it no longer match its recorded migrations), so extension drift does not block deploy-draft; spec user story 40's mention of deploy-draft is not implemented. Only the TerminalRequiredError path is tested at the API seam.
