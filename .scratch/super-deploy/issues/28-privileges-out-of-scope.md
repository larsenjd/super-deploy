# 28: Privileges, ownership and row-level security are outside the system

**What to build:** super-deploy stops managing grants, roles, policies and `SECURITY DEFINER`. They are refused in every file it deploys, and on targets they are left alone and never compared. It also checks its one assumption about ownership, that the deploy role owns everything in the managed schema, and refuses up front instead of failing partway through a deploy. See ADR-0006, REFINEMENTS "Privileges, ownership and row-level security" and "`SECURITY DEFINER` routines", and GLOSSARY "Deploy role". This undoes most of 25.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Spec:** `../spec.md` (stories 65, 67, 98, 99; "Rules: desired schema", "Rules: deploy-time SQL", "Differ", "Deployment engine and history schema", "Guarded and recovery commands", "Out of Scope")

## Rules

- [ ] The desired schema refuses, as a structural rule with no override: `GRANT`, `REVOKE`, `CREATE POLICY`, `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY`, and the `SECURITY DEFINER` routine option. Role statements, role membership, `OWNER TO`, `ALTER DEFAULT PRIVILEGES`, `REASSIGN OWNED` and `DROP OWNED` stay refused. Each message says privileges and row-level security are set up on targets outside super-deploy.
- [ ] Deploy-time rules refuse the same statements in every deploy-time file, including generated schema changes (the `privileges` class goes, except for `COMMENT`, which keeps its current rule).
- [ ] What becomes unused goes: the grant checks in `desired-schema-rules.ts`, `sql-analysis/grants.ts`, `sql-analysis/roles.ts`, grant and revoke statement kinds and their ordering and reference handling, and the grant cases in `schemas.ts`.

## Differ and comparison

- [ ] pg-delta's `plan()` excludes ACLs, default privileges, policies and RLS flags (its `policy.filter` option), so a schema change never contains them. `assumedRoles` is no longer needed. Ownership stays pruned as now.
- [ ] The catalog comparison (`verification/catalog.ts`) no longer reads ACLs (objects, columns, the managed schema), policies or a table's RLS flags. Drift, `mark`, `status`, rehearsals, order-independence and adoption's reproduction check therefore never see them. `schemaSetupRoles` goes if nothing else uses it.
- [ ] A hand-made grant, default privilege or policy on a target is not drift, and `deploy` succeeds over it.

## Rehearsals and pre-flight

- [ ] Rehearsals create no roles (`ensureRoles` goes), and the rehearsal login no longer needs `CREATEROLE` (adapter docs in `adapters/types.ts` and `node-postgres.ts`).
- [ ] The pre-flight check that every granted role exists on the target goes, with its `PreflightFailedError` reason.
- [ ] A new pre-flight refusal, shared by `deploy`, `status`, `deploy-draft`, `adopt` and `mark`: the managed schema, or any object in it, is owned by a role the deploy role is not a member of (`pg_has_role(current_user, owner, 'MEMBER')`, so `public`, owned by `pg_database_owner`, passes when the deploy role owns the database). The message lists each object and its owner, with the `ALTER ... OWNER TO` that fixes it. `status` lists it under "Deploy would refuse". A target without the managed schema yet passes.
- [ ] The superuser and predefined-role warnings stay as they are.

## Commands

- [ ] `rebuild` drops the managed schema's objects and leaves the schema's grants and default privileges untouched. Its revoke step, the unrevoked-grant check and `WipeFailedError`'s grant reasons go. Fix the comment at `commands/rebuild.ts:5-8`.
- [ ] `init --adopt` leaves grants, policies and RLS flags out of the desired schema and prints one line saying how many were left as they are on the target. It refuses a target with a `SECURITY DEFINER` routine in the managed schema, and a target that fails the ownership check, naming the objects.

## Docs

- [ ] The template README's "Permissions" section is rewritten. The desired schema declares no privileges. Each target needs the deploy role to own the managed schema (or belong to its owner) and have `CREATE` on the database for the first deployment. Application roles, their grants and any policies are set up outside super-deploy, recommended through `ALTER DEFAULT PRIVILEGES FOR ROLE <deploy role> IN SCHEMA <schema> GRANT ...`, which no longer causes drift. A migration that drops and recreates a table loses grants and policies made on it by hand. The `SECURITY DEFINER` examples go. External schemas: the application's roles, not the deploy role, need their grants.
- [ ] `spec.md` matches: stories 65, 98 and 99 removed or rewritten, the supported object types and grant rules, "grants are diffed", placeholder roles, the pre-flight sequence, target setup, rebuild's grant semantics, and Out of Scope gaining grants, policies and `SECURITY DEFINER`.

## Tests

- [ ] `managed-schema-grants.test.ts` is replaced by tests that a hand-made grant, default privilege and policy on a target are not drift and survive `deploy` and `rebuild`.
- [ ] Pre-flight tests: no more role creation or missing-role refusals. The ownership refusal is covered for a table, function and schema owned by another role, and passes when the deploy role is a member of the owner. The deploy-role warnings are unchanged.
- [ ] Rule tests: each refused statement in the desired schema and in each deploy-time file kind, `SECURITY DEFINER` included. Grant allow-cases, grant ordering and the pg-delta grant fixtures (`078`–`080`) go.
- [ ] Adoption tests: grants and policies are left out with the count line, and `SECURITY DEFINER` and foreign-owned objects are refused.
- [ ] Round-trip and ordering fixtures lose their roles and grants (`fixtures/round-trips.ts`, `fixtures/ordering.ts`, `support/round-trip.ts`).
