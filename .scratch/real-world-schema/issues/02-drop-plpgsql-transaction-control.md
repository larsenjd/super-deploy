# 02: Allow `COMMIT` and `ROLLBACK` in routine bodies

**What to build:** A procedure that commits or rolls back (an application batch job committing in chunks, say) is accepted in the desired schema and in schema changes. The `plpgsql-transaction-control` rule is deleted: it protects nothing.

- No deploy-time SQL can run a routine body's transaction control. Scripts and seed data refuse `CALL`, `DO` and direct calls to user-defined functions; triggers fired by DML run functions, and PostgreSQL never lets a function commit.
- If one did run inside the deploy transaction, PostgreSQL raises `invalid transaction termination` (SQLSTATE 2D000) and the deployment rolls back (`.scratch/super-deploy/research/transactional-hazards.md` §4.6, §4.7).

Transaction control written directly in deploy-time SQL (`transaction-control`) stays refused and never overridable: that one would end the deploy transaction.

Found on a real-world schema: 3 `plpgsql-transaction-control` violations.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `plpgsql-transaction-control` is removed from `sql-analysis/rule-catalogue.ts` and from the PL/pgSQL body checks in `sql-analysis/routine-bodies.ts`, for both rule sets.
- [ ] A desired-schema procedure whose body has `COMMIT` and `ROLLBACK` is accepted, drafts, rehearses and deploys (API seam).
- [ ] `transaction-control` in scripts, and `CALL` and `DO` in deploy-time SQL, are still refused (existing tests keep passing).
- [ ] `init --adopt` of a target with such a procedure no longer reports it (`test/integration/adopt.test.ts` expects it today).
- [ ] Spec user story 41 (`.scratch/super-deploy/spec.md`) checks bodies for dynamic SQL and denylisted calls only, with a sentence on why transaction control in a body is safe. The research rows §4.6 and §4.7 note the decision.
- [ ] The template README says nothing that implies routine bodies may not commit.
