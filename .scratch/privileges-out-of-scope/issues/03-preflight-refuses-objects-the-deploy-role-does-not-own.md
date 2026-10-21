# 03: Pre-flight refuses objects the deploy role doesn't own

**What to build:** super-deploy assumes the deploy role owns the managed schema and everything in it (GLOSSARY "Deploy role", ADR-0006). When a target breaks that assumption, every command that would act on it refuses up front with a message listing what to fix, instead of failing with "must be owner" partway through a deploy. This resolves QA 28 and 65. Parent: `.scratch/super-deploy/issues/28-privileges-out-of-scope.md`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A new pre-flight refusal: the managed schema, or any object in it (tables, views, sequences, routines, types, domains and so on), is owned by a role the deploy role is not a member of. Membership counts, as it does for PostgreSQL's own ownership checks, so `public`, owned by `pg_database_owner`, passes when the deploy role owns the database. A target without the managed schema yet passes.
- [ ] The message lists each object, its owner, and the `ALTER ... OWNER TO <deploy role>` that fixes it.
- [ ] `deploy` and `deploy-draft` refuse, and `status` lists it under "Deploy would refuse" (API seam).
- [ ] `init --adopt` refuses a target with a table, view and function owned by another role, naming each, before any rehearsal or writing (API seam).
- [ ] `mark` refuses before asking YES when the hand-applied objects belong to another role (the reproduction from QA 65).
- [ ] After `ALTER ... OWNER TO <deploy role>`, or with the deploy role made a member of the owner, each command proceeds without the refusal.
- [ ] The superuser and predefined-role warnings are unchanged. Messages that say "ownership aside" are reworded, since ownership is now checked.
