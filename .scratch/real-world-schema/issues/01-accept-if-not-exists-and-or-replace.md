# 01: Accept `IF NOT EXISTS` and `OR REPLACE` in the desired schema

**What to build:** A desired schema written to be re-runnable loads without changes. The six redefinition forms are accepted and change nothing: the desired schema always loads into an empty schema, and the `duplicate-object` rule (`sql-analysis/ordering.ts`) already refuses two statements creating the same object before anything loads, whatever their clauses. "Each object is defined exactly once" stays the rule; `duplicate-object` is what enforces it.

Found on a real-world schema: 171 `desired-schema-statement` violations from these clauses. Any other statement forms among them are triaged separately.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] These forms are accepted in desired-schema files, with no warning: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE MATERIALIZED VIEW IF NOT EXISTS`, `CREATE OR REPLACE VIEW`, `CREATE OR REPLACE FUNCTION` / `PROCEDURE`, `CREATE OR REPLACE TRIGGER` (the `redefinition` call sites in `desired-schema-rules.ts`).
- [ ] Nothing else becomes allowed. `ALTER TABLE IF EXISTS` stays refused, with its current message reworded to stand alone. A statement refused for another reason (`CREATE SCHEMA IF NOT EXISTS`, `CREATE EXTENSION IF NOT EXISTS`) is still refused for that reason.
- [ ] Ordering handles each accepted form like its plain counterpart: `statementFacts` (`references.ts`) extracts the same facts, so dependencies, identity and tie-breaks are unchanged.
- [ ] Two statements creating the same object are still refused as `duplicate-object` when either or both carry a clause, for every form above (e.g. two `create or replace function f(int)` with different bodies in two files).
- [ ] A desired schema using each form drafts the same schema change as the same schema without the clauses (API seam).
- [ ] Spec "Rules: desired schema" (`.scratch/super-deploy/spec.md`, the "Refused because no load order could make them deterministic" line): drop `IF NOT EXISTS` and `OR REPLACE` from the refused list, and add that they are accepted and change nothing because the desired schema loads into an empty schema and two statements creating the same object are refused.
- [ ] Template README "Define each object exactly once" (`packages/template/README.md`): says the clauses are accepted, that defining an object twice is refused as `[duplicate-object]`, and that `ALTER TABLE IF EXISTS` is still refused.
- [ ] Tests asserting these clauses are refused (`test/unit/sql-analysis/desired-schema-rules.test.ts` and any others) are rewritten to the behaviour above.
