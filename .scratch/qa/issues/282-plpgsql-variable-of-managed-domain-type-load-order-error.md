# 282: A PL/pgSQL variable declared with a managed domain type makes draft fail with "depends on load order ... please report it"

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** privs
**Round:** 3

## What I did
`managedSchema: "app"`, and a desired-schema file `data-model/desired-schema/zz_probe.sql` holding:

```sql
create domain short_label as text constraint short_label_len check (length(value) < 20);

create function f_decl_domain() returns text
language plpgsql stable
set search_path = app, pg_catalog
as $$
declare
  v app.short_label := 'x';
begin
  return v;
end
$$;
```

```sh
pnpm exec super-deploy draft --name probe
```

## Expected
A draft that creates the domain first and the function after it, as for any other reference to a domain.

## Actual
```
Error: The desired schema depends on load order: it loads in one valid order but not in another, where data-model/desired-schema/zz_probe.sql:8 fails: type "app.short_label" does not exist. super-deploy may not see a reference this statement makes; please report it
```

The same happens with the type unqualified (`v short_label := 'x';`, without `SET search_path`). Line 8 is the `DECLARE`d variable. As far as I can tell from the docs, there is no way to declare a PL/pgSQL variable of a domain the desired schema creates.

## Notes
- Guess: dependencies are taken from the routine's body statements but not from its `DECLARE` section. PostgreSQL's PL/pgSQL validator resolves those types at `CREATE FUNCTION`, so the order matters.
- `customers%rowtype` and `customers.name%type` in `DECLARE` didn't trigger this error in my test, perhaps because tables happen to come first. They are missed by the unqualified-name warning, though (see 283).
