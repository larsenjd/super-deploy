# 280: SET LOCAL ROLE in a routine body (and a routine's SET role option) isn't refused, so a trigger can switch a deployment's role

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** privs
**Round:** 3

## What I did
Project with `managedSchema: "app"` and a real target `chaos` (database `qa3_privs_chaos`), deployed as the non-superuser `qa3_privs_deploy`. On the server, as a superuser:

```sql
create role qa3_privs_owner nologin;
grant qa3_privs_owner to qa3_privs_deploy;            -- with inherit, as the README allows
grant create, usage on schema app to qa3_privs_owner; -- on qa3_privs_chaos
```

The desired schema (on top of a `customers` table already deployed):

```sql
create function trg_role() returns trigger language plpgsql as $$
begin
  if exists (select from pg_roles where rolname = 'qa3_privs_owner') then
    set local role qa3_privs_owner;
  end if;
  return new;
end
$$;

create trigger customers_role before update on customers for each row execute function trg_role();
```

`draft --name "role trigger"` and `finalize` both succeed with nothing refused. Then I added a table `notes` to the desired schema, ran `draft --name notes`, and set `data-model/draft/pre-migration.sql` to:

```sql
update customers set name = name;
```

`finalize` succeeds. With one row in `app.customers` on the target:

```sh
pnpm exec super-deploy deploy --target chaos
```

Also accepted with nothing refused, in the desired schema:

```sql
create function setrole_opt() returns text language sql set role = pg_database_owner as $$ select current_user::text $$;
```

## Expected
The README ("What the desired schema declares") says roles and privileges are refused everywhere, "including inside a function's or procedure's body". Scripts refuse `SET LOCAL ROLE` because "a deployment runs everything as the deploy role". So I expected `SET LOCAL ROLE` in a PL/pgSQL body, and a routine's `SET role = ...` option, to be refused with the same reason.

## Actual
Neither is refused. The trigger fires during the pre-migration script, and its `SET LOCAL ROLE` lasts until the end of the deployment's transaction. Everything after it runs as `qa3_privs_owner`: the schema change, then super-deploy's own history bookkeeping, which fails with a bare error. The error names no file, doesn't say the deployment rolled back, and doesn't say why the role changed:

```
Error: permission denied for schema deployment_history
```

`status` then shows `#5 deploy failed migrations 2-3 ...: permission denied for schema deployment_history`. If `qa3_privs_owner` had been able to write the history schema, the deployment would have committed with `notes` owned by `qa3_privs_owner` rather than the deploy role.

`set role = pg_database_owner` as a routine option passes `draft` and `finalize`, because rehearsals run as a superuser. It then fails at deploy:

```
Error: data-model/migrations/00001-base/schema-change.sql:28: PostgreSQL refused it: permission denied to set role "pg_database_owner". The deployment rolled back: target chaos is unchanged, with no migration recorded.
```

## Notes
- PostgreSQL itself confirms that a plain SECURITY INVOKER function with `SET role = x` runs as `x` for any caller who is a member of `x`. So it is a role switch much like SECURITY DEFINER.
- Also unrefused, though less clearly a problem: `set session_authorization = ...` and `set row_security = off` as routine options.
