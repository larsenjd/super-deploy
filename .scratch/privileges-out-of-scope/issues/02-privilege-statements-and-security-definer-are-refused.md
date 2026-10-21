# 02: Privilege statements and `SECURITY DEFINER` are refused

**What to build:** A user who writes a grant, a policy or a `SECURITY DEFINER` routine anywhere super-deploy deploys from gets a clear refusal saying that privileges and row-level security are set up on targets outside super-deploy. super-deploy stops knowing about any role but the deploy role: rehearsals create no roles, and pre-flight no longer checks that granted roles exist. See ADR-0006 and REFINEMENTS "`SECURITY DEFINER` routines". Parent: `.scratch/super-deploy/issues/28-privileges-out-of-scope.md`.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] The desired schema refuses `GRANT`, `REVOKE`, `CREATE POLICY`, `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` and the `SECURITY DEFINER` routine option. These are structural refusals: an override marker cannot bypass them. Role statements, role membership, `OWNER TO`, `ALTER DEFAULT PRIVILEGES`, `REASSIGN OWNED` and `DROP OWNED` stay refused, with messages reworded to match.
- [ ] Pre-migration scripts, post-migration scripts, seed data and generated schema changes refuse the same statements. `COMMENT` keeps its current rule.
- [ ] `init --adopt` of a target with a `SECURITY DEFINER` routine in the managed schema refuses, naming the routine.
- [ ] A rehearsal creates no roles, and the rehearsal login no longer needs `CREATEROLE` (adapter docs say so).
- [ ] Pre-flight no longer refuses for a missing granted role. `status` and `deploy` don't mention granted roles.
- [ ] Code that only existed for grants, revokes, policy roles and placeholder roles is deleted: allowlist checks, grant and role helpers, grant ordering and references, and the round-trip and ordering fixtures' roles and grants.
- [ ] Rule tests cover each refused statement in the desired schema and in each deploy-time file kind, `SECURITY DEFINER` included. The grant allow-cases and pg-delta grant fixtures go.
