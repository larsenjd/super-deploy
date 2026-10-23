# 223: The ownership list leaves out objects refused for another reason, so the fixes take two rounds

**Status:** needs-triage
**Category:** bug
**Severity:** low
**Area:** adopt
**Round:** 3

## What I did
Database `qa3_adopt_pub`, owned by `qa3_adopt_legacy`, managed schema `public`
(the default), with deploy role `qa3_adopt_pubdeploy`:

```sql
create extension pgcrypto;
set role qa3_adopt_legacy;
create table public.accounts (id bigint generated always as identity primary key, email text not null, pw text not null default crypt('x', gen_salt('bf')));
create table public.sessions (id uuid primary key default gen_random_uuid(), account_id bigint references public.accounts(id));
create view public.active as select a.id from public.accounts a;
```

```sh
pnpm exec super-deploy init --adopt qa </dev/null
```

Then I fixed what it listed: I dropped the `pw` default and the extension, and
ran every statement of its "To fix, run as a superuser" script. Then I adopted again.

## Expected
The first refusal lists every object the deploy role doesn't own, including
`table public.accounts`, which `qa3_adopt_legacy` owns. The README says only
that "an object that must be changed anyway" is left out of the fix
*statements*. Once I'd made the changes and run the script, adoption should succeed.

## Actual
First run:

```
  table public.accounts
    unknown-reference: table accounts references function public.crypt, which the desired schema doesn't create
  ...
The deploy role on target qa doesn't own 4 objects in the managed schema:
  schema public (owned by pg_database_owner (the owner of database qa3_adopt_pub, qa3_adopt_legacy))
  function public.audit() (owned by qa3_adopt_legacy)
  table public.sessions (owned by qa3_adopt_legacy)
  view public.active (owned by qa3_adopt_legacy)
```

`public.accounts` isn't in the ownership list at all. Second run, after the
fixes:

```
The deploy role on target qa doesn't own 1 object in the managed schema:
  table public.accounts (owned by qa3_adopt_legacy)
To fix, run as a superuser:
  ALTER TABLE public.accounts OWNER TO qa3_adopt_pubdeploy;
Error: Cannot adopt target qa: the deploy role doesn't own 1 object in the managed schema, ...
```

Changing a column default doesn't change the owner, so this object needed
an `OWNER TO` all along. Each adoption round is a trip to a DBA.

## Notes
Suggestion: always list the object, and still include its `OWNER TO`. Leave
the statement out only when the fix replaces the object (drop and recreate),
or add a comment saying so.
