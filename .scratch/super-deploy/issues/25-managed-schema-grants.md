# 25: Managed-schema grants and revokes of PUBLIC defaults

**What to build:** The desired schema can grant `USAGE` on the managed schema and revoke PostgreSQL's default `PUBLIC` privileges on the objects it defines, so that a named managed schema needs no hand-made grants and a `SECURITY DEFINER` function can be restricted to the roles granted it. See ADR-0002 and REFINEMENTS "Roles, grants and ownership".

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Spec:** `../spec.md` (stories 98–99, "Rules: desired schema", "Differ", "Deployment engine and history schema", "Guarded and recovery commands")

- [ ] Desired-schema rules allow `GRANT USAGE ON SCHEMA <managed schema> TO <role>`, and `REVOKE EXECUTE ON FUNCTION/PROCEDURE … FROM PUBLIC` and `REVOKE USAGE ON TYPE/DOMAIN … FROM PUBLIC` for objects the desired schema defines. Refused, with a reason: `CREATE` or `ALL` on the schema, grants on any other schema, `REVOKE` from any role other than `PUBLIC`, and `REVOKE` of a privilege `PUBLIC` doesn't have by default. Ordering places them after the objects they name.
- [ ] Granted-role checks (rehearsal placeholder roles, `status` and `deploy` pre-flight) include schema `USAGE` grantees.
- [ ] Generated schema changes add and remove these grants and revokes; deploy-time rules allow them in generated schema changes only, never in scripts.
- [ ] The catalog comparison, drift check, `mark` and `draft`/`finalize` verification compare the managed schema's own grants (owner normalised as for other objects). A schema grant made by hand on a target is drift.
- [ ] `rebuild --to N` leaves the managed schema's grants exactly as migrations 1 to N declare, removing any others. This applies to `public` too, whose defaults (`USAGE` for `PUBLIC`) count as declared when no migration revokes them.
- [ ] `init --adopt` writes the managed schema's `USAGE` grants and any revoked `PUBLIC` defaults into the desired schema instead of refusing them.
- [ ] Tests cover a named managed schema where an app role reads a table through grants alone, and a `SECURITY DEFINER` function that `PUBLIC` can no longer execute.
- [ ] The template README gets a "Permissions" section: what the desired schema declares, and what each target needs set up outside super-deploy (spec "Target setup that stays outside super-deploy"). It includes the example of a trigger whose `SECURITY DEFINER` function reads an external schema, and the warning that `ALTER DEFAULT PRIVILEGES` for the deploy role causes drift.
