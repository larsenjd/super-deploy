# Privileges, ownership and row-level security are outside the system in V1

super-deploy knows about one role, the deploy role, which owns the managed schema and everything in it. Grants, revokes, default privileges, other roles, ownership changes, row-level security and `SECURITY DEFINER` routines are refused in the desired schema and in every deploy-time file. Grants, policies and RLS flags that exist on a target are never created, compared, revoked or reset. Real databases need them, so they are allowed on targets but set up outside super-deploy, typically with `ALTER DEFAULT PRIVILEGES FOR ROLE <deploy role>` so that new objects are granted automatically. We chose this over the grant support V1 already had (grants declared in the desired schema, diffed and compared as drift, with placeholder roles in rehearsals) because privileges kept producing hard edge cases: grants an admin made that the deploy role can't revoke, default privileges that drift a target after every deploy, roles that exist in rehearsals but not on targets, and objects owned by other roles. Getting privileges right is a large area of its own, and V1 ships without it.

## Consequences

- `SECURITY DEFINER` is refused because, without `REVOKE EXECUTE ... FROM PUBLIC`, any role that can connect could call a function running with the deploy role's rights.
- Since ownership is assumed rather than managed, `deploy`, `status`, `deploy-draft`, `adopt` and `mark` refuse a target where the managed schema or an object in it is owned by a role the deploy role is not a member of. Without that check, such a target fails at deploy with "must be owner" partway through.
- A migration that drops and recreates an object loses the grants and policies made on it by hand, and super-deploy cannot notice.
- `rebuild` drops the managed schema's objects and leaves the schema's grants and default privileges as they are.
- What would justify revisiting this is in REFINEMENTS "Privileges, ownership and row-level security".
