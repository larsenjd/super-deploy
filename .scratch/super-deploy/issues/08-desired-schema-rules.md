# 08: Desired-schema rules

**What to build:** The desired schema accepts exactly the supported statements and object types, and refuses everything else with a clear reason, including inside PL/pgSQL bodies.

**Blocked by:** 03

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] Allowed: `CREATE` of supported object types, `COMMENT ON`, `GRANT`, `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY`, `ALTER TABLE … ADD CONSTRAINT`, `CREATE EXTENSION plpgsql`.
- [ ] Every refused object type in the spec has a fixture, including enums, partitioned tables, `serial`, `NOT ENFORCED`, and `VIRTUAL` generated columns (including PG18's keyword-less default).
- [ ] PL/pgSQL bodies parsed: `EXECUTE`, `COMMIT`/`ROLLBACK`, denylisted calls and references to undeclared schemas refused.
- [ ] `externalSchemas` from config honoured in PL/pgSQL bodies; objects that bind at `CREATE` referencing an external schema fail in rehearsal with a hint explaining why.
- [ ] Each supported object type round-trips through `draft`, `finalize` and `deploy` (reuse the scenarios from `prototype/pg-delta`).
