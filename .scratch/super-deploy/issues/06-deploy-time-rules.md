# 06: Deploy-time rules

**What to build:** A developer who writes something unsafe in deploy-time SQL is stopped at `draft`, `finalize` or `validate` with the file, line, statement and rule. The full allowlist from the spec is enforced, including on generated schema changes.

**Blocked by:** 03

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] Refused: every statement PostgreSQL rejects in a transaction block, transaction control, `CALL`, `DO`.
- [ ] Functions: `pg_catalog` only, minus the side-effect denylist; user-defined functions may not be called directly; volatile built-ins allowed.
- [ ] Column-order constructs refused: `INSERT` without columns, `SELECT *` and `t.*` (incl. `RETURNING`), ordinal `ORDER BY`/`GROUP BY`, `NATURAL JOIN`, whole-row references, `COPY`.
- [ ] Explicit values into identity columns refused.
- [ ] DML, temp-table and other-statement rules exactly as in the spec.
- [ ] References limited to the managed schema, the script's temp tables, and reading `pg_catalog`.
- [ ] Per-file-kind rules: pre-migration DDL and DML; post-migration DML only; seed data `INSERT` with column lists only; generated schema changes checked too.
- [ ] Database-free fixture suite at the SQL-analysis seam: a refused fixture for every hazard in `research/transactional-hazards.md` and an allowed fixture for every allowed form.
