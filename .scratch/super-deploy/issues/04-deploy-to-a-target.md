# 04: Deploy to a target

**What to build:** A release engineer runs `deploy --target dev` and every pending migration is applied in one transaction and recorded in the target's history schema. `status --target dev` shows what's pending and the recent attempts.

**Blocked by:** 03

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] The first deployment creates the history schema (default `deployment_history`, configurable) inside its transaction, with migrations, attempts and settings tables.
- [ ] Each attempt is logged on a second connection outside the deploy transaction: running, then succeeded or failed.
- [ ] A session-level advisory lock is taken with try-lock, keyed from the history schema name.
- [ ] Inside the transaction: `SET LOCAL` search path (managed schema, then `pg_catalog`), time zone UTC, fixed date and interval styles, the target's lock timeout (default 5s) and optional statement timeout.
- [ ] Each migration's history row is written inside the transaction.
- [ ] A deployment rehearses the pending migrations on a throwaway database before touching the target.
- [ ] `status` lists pending migrations and recent attempts.
- [ ] Commands connect only to the target they name.
- [ ] Tested at the API seam against an `embedded-postgres` target.
