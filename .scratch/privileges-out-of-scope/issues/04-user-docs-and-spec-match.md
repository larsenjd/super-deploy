# 04: User docs and spec match

**What to build:** A user reading the template README knows that super-deploy declares no privileges, what each target needs set up outside it, and how to grant the application's roles access to what deployments create. The V1 spec says the same. Parent: `.scratch/super-deploy/issues/28-privileges-out-of-scope.md`.

**Blocked by:** 01, 02, 03

**Status:** ready-for-agent

- [ ] The README's "Permissions" section is rewritten:
  - The desired schema declares no grants, revokes, policies, row-level security or `SECURITY DEFINER` routines.
  - The deploy role must own the managed schema and everything in it, or belong to the owning role, and needs `CREATE` on the database for the first deployment.
  - Application roles, their grants and any policies are set up on each target outside super-deploy. The recommended way is `ALTER DEFAULT PRIVILEGES FOR ROLE <deploy role> IN SCHEMA <schema> GRANT ...`, which no longer counts as drift; the old warning against it goes.
  - A migration that drops and recreates a table loses grants and policies made on it by hand.
  - A migration that changes the type of, or drops, a column a hand-made policy uses fails at deploy, and rehearsals can't catch it: drop the policy, deploy, then create it again.
  - Grants on external schemas go to the application's roles, since routines run as their caller.
  - The `SECURITY DEFINER` examples go.
- [ ] Every other README mention of grants, placeholder roles or rebuild's grant handling is updated.
- [ ] The spec matches. Stories 65, 98 and 99 are removed or rewritten. The supported object types, desired-schema rules, deploy-time rules, differ notes, pre-flight sequence, target setup and rebuild semantics are updated. "Out of Scope" lists grants, policies, row-level security and `SECURITY DEFINER`.
