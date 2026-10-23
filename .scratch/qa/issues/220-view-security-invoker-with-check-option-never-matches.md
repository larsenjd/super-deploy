# 220: A view with `security_invoker` and `WITH CHECK OPTION` can't be adopted or finalized

**Status:** needs-triage
**Category:** bug
**Severity:** high
**Area:** adopt
**Round:** 3

## What I did
Both options are on the README's supported list ("Views (with the options
`security_invoker`, `security_barrier` and `check_option`)"), and the
Permissions section tells you to use `security_invoker` on views over tables
with policies.

**Adoption.** On a target (`managedSchema: "core"`, deploy role owns everything):

```sql
create schema core;
create table core.projects (id bigint generated always as identity primary key, title text not null, ends date);
create view core.open_projects with (security_invoker = true) as
  select id, title from core.projects where ends is null
  with local check option;
```

```sh
pnpm exec super-deploy init --adopt qa
```

**Normal draft.** In an already-adopted project, I added this to `data-model/desired-schema/views.sql`:

```sql
create view core.my_projects with (security_invoker = true) as
  select id, title from core.projects where tenant_id = 1000
  with local check option;
```

(`core.projects` there also has `tenant_id integer not null`.)

```sh
pnpm exec super-deploy draft --name "my projects"
pnpm exec super-deploy finalize </dev/null
```

## Expected
The view is adopted, and the draft finalizes. Both options are supported.

## Actual
Adoption refuses the view:

```
  view core.open_projects
    not-reproduced: The desired schema generated from the target creates it differently: on the target: relation: v open_projects persistence=p options={security_invoker=true,check_option=local} am=- replident=n inherits={} partkey=- bound=-; generated: relation: v open_projects persistence=p options={check_option=local,security_invoker=true} am=- replident=n inherits={} partkey=- bound=-
Error: Cannot adopt target qa: its managed schema has 2 things V1 doesn't support, listed above. Nothing was written; change the target first, then adopt again
```

`draft` warns, and `finalize` refuses:

```
warning: The generated schema change doesn't produce the desired schema: pg-delta can't generate the difference: make the change by hand in the pre-migration script
  catalog: from the migrations: relation: v my_projects persistence=p options={check_option=local,security_invoker=true} ...
  catalog: from the desired schema: relation: v my_projects persistence=p options={security_invoker=true,check_option=local} ...
Error: The rehearsal does not match the desired schema, and running draft again won't change that: pg-delta can't generate the difference: make the change by hand in the pre-migration script (2 differences, listed above)
```

The two sides differ only in the order of the same two options. The advice
("make the change by hand in the pre-migration script") can't help.

## Notes
- Workaround: write the options in alphabetical order, as
  `with (check_option = local, security_invoker = true)` and without the trailing
  `WITH LOCAL CHECK OPTION`. Then `draft` and `finalize` succeed. On a target,
  `alter view ... reset (security_invoker, check_option); alter view ... set (check_option=local, security_invoker=true)`
  lets adoption go ahead.
- Guess: the catalog comparison compares `pg_class.reloptions` as an ordered
  array. The generated SQL sorts the options, while
  `WITH (security_invoker) ... WITH LOCAL CHECK OPTION` stores them in the order written.
