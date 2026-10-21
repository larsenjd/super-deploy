# 01: Privileges on a target are left alone

**What to build:** A DBA can set up grants, default privileges, policies and row-level security on a target by hand, and super-deploy never treats them as drift, never generates statements that change them, and never resets them. `adopt` leaves them out of the desired schema it writes. See ADR-0006 and REFINEMENTS "Privileges, ownership and row-level security". Parent: `.scratch/super-deploy/issues/28-privileges-out-of-scope.md`.

Until 02 lands, grants still declared in a desired schema are accepted but no longer deployed. That is expected.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Generated schema changes never contain grants, revokes, default privileges, policies or RLS flag changes. pg-delta's own filtering does this; ownership stays pruned as now.
- [ ] The catalog comparison no longer reads ACLs (on objects, columns or the managed schema), policies or a table's RLS flags. Drift, `mark`, `status`, rehearsals, order-independence and adoption's reproduction check all follow from it.
- [ ] A grant, an `ALTER DEFAULT PRIVILEGES` for the deploy role, a policy and `ENABLE ROW LEVEL SECURITY`, each made by hand on a deployed target, show no drift in `status`. `deploy` of the next migration succeeds, and the default privileges apply to the objects it creates (API seam).
- [ ] `rebuild` drops the managed schema's objects and leaves the schema's grants and default privileges untouched, including grants an administrator made that the deploy role couldn't revoke. The unrevoked-grant failure goes.
- [ ] `init --adopt` of a target with object grants, a schema `USAGE` grant, revokes of `PUBLIC` defaults and a policy writes none of them into the desired schema, reproduces cleanly, and prints one line counting the grants and policies left on the target as they are.
- [ ] Adopting a target with default privileges for the deploy role succeeds (the reproduction case from QA 26).
- [ ] Tests that asserted grants are deployed, compared or reset are removed or rewritten to the behaviour above.
