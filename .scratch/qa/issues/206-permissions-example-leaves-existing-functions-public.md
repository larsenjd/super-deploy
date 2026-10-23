# 206: Following "Permissions" after the first deploy leaves the first migration's functions executable by PUBLIC

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** newproj
**Round:** 3

## What I did
New project with `managedSchema: "app"`, a function in the desired schema, a real target whose deploy role (`qa3_newproj_deploy2`) has `CREATE` on the database. First `deploy --target qa` creates schema `app` and the function. Then, as the README says ("once the managed schema `app` exists, run as the deploy role on each target"), as the deploy role:

```sql
grant usage on schema app to qa3_newproj_app_user;
alter default privileges for role qa3_newproj_deploy2 in schema app grant select, insert, update, delete on tables to qa3_newproj_app_user;
alter default privileges for role qa3_newproj_deploy2 revoke execute on functions from public;
alter default privileges for role qa3_newproj_deploy2 in schema app grant execute on functions to qa3_newproj_app_user;
-- "Default privileges apply only to objects created afterwards: grant on what already exists too"
grant select, insert, update, delete on all tables in schema app to qa3_newproj_app_user;
grant execute on all functions in schema app to qa3_newproj_app_user;
```

```sql
select proname, proacl from pg_proc where pronamespace = 'app'::regnamespace;
```

## Expected
The setup the README recommends leaves functions callable only by the roles granted.

## Actual
```
account_count  {=X/qa3_newproj_deploy2,qa3_newproj_deploy2=X/...,qa3_newproj_app_user=X/...}
total_balance  {=X/qa3_newproj_deploy2,...}
```

`=X` : every role can still execute the functions created by the first migration. The README stresses that the PUBLIC revoke must be a global default privilege, and says to *grant* on what already exists, but not to *revoke* `EXECUTE ... FROM PUBLIC` on the functions that already exist. Since the schema only exists after the first deployment (unless a DBA creates it first), every project following the README in that order hits this.

## Notes
- Fix in the docs: add `revoke execute on all functions in schema app from public;` (and procedures) to the "what already exists" line, or recommend running the global `alter default privileges ... revoke execute on functions from public` before the first deployment (it doesn't need the schema).
