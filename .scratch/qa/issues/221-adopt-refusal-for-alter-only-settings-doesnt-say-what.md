# 221: Adoption refuses replica identity, disabled triggers and NOT VALID domain checks without saying which setting

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** adopt
**Round:** 3

## What I did
I adopted three targets, each with one common hand-made setting that only an
`ALTER` statement can make. The deploy role owns everything, and
`managedSchema` is set:

```sql
-- 1. replica identity (common on tables used by logical replication / CDC)
create schema core;
create table core.projects (id bigint generated always as identity primary key, title text not null);
alter table core.projects replica identity full;

-- 2. a disabled trigger
create schema e;
create table e.a (id int primary key, name text);
create function e.trg() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger a_trg before insert on e.a for each row execute function e.trg();
alter table e.a disable trigger a_trg;

-- 3. a domain check added NOT VALID
create domain e.d3 as int;
alter domain e.d3 add constraint d3_pos check (value > 0) not valid;
```

```sh
pnpm exec super-deploy init --adopt qa </dev/null
```

## Expected
As the README says for refusals: "Each object is named as PostgreSQL names it
(`table app.users`), with the references or settings refused". So I expected
something like `table core.projects: REPLICA IDENTITY FULL is not supported:
ALTER TABLE core.projects REPLICA IDENTITY DEFAULT`, and similar for the
disabled trigger and the NOT VALID check.

## Actual
```
Target qa has 1 thing V1 doesn't support:
  table core.projects
    desired-schema-statement: Only ALTER TABLE ... ADD CONSTRAINT is allowed in the desired schema; declare everything else in CREATE TABLE
```

```
Target qa has 2 things V1 doesn't support:
  table e.a
    desired-schema-statement: Only ALTER TABLE ... ADD CONSTRAINT is allowed in the desired schema; declare everything else in CREATE TABLE
  domain e.d3
    desired-schema-statement: ALTER DOMAIN is not allowed in the desired schema
```

The message is the one for a hand-written desired schema. The user never
wrote an `ALTER`: it comes from SQL super-deploy generated from the target.
"Declare everything else in CREATE TABLE" is impossible here, since
`CREATE TABLE` can't set a replica identity or disable a trigger. Nothing names
the setting, so I had to bisect by undoing settings one at a time
(`replica identity default`, `enable trigger`, `validate constraint`) to find
the cause.

## Notes
- The README doesn't mention replica identity, disabled triggers or NOT
  VALID domain constraints anywhere. NOT VALID table constraints are adopted
  correctly (`ADD CONSTRAINT ... NOT VALID`), so a user would expect domain ones to work too.
- Each refusal should name the setting, and give the statement that removes it
  on the target, the way the view-column-comment refusal does.
