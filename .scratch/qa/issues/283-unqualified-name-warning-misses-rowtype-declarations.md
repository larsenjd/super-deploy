# 283: The unqualified-name warning misses `%ROWTYPE` and `%TYPE` declarations, which fail for app roles

**Status:** needs-triage
**Category:** bug
**Severity:** low
**Area:** privs
**Round:** 3

## What I did
`managedSchema: "app"`, with a table `customers` in the desired schema, plus:

```sql
create function f_rowtype(p_id bigint) returns text
language plpgsql stable
as $$
declare
  r app.customers%rowtype;
  c customers%rowtype;
begin
  select * into r from app.customers where id = p_id;
  return r.name;
end
$$;
```

```sh
pnpm exec super-deploy draft --name probe
```

To check what an app role sees, I created the same function on a scratch database as a superuser (with `search_path = app` while creating it, as a rehearsal has), granted `qa3_privs_writer` `USAGE` on `app`, `SELECT` on the table and `EXECUTE` on the function, and called it as `qa3_privs_writer`:

```sql
select app.f_rowtype(1);
```

## Expected
The README ("Routine bodies run with the caller's search path") says `draft`, `finalize` and `validate` warn about a routine whose string body names something the desired schema creates without a schema. `customers%rowtype` is such a name, so I expected the warning.

## Actual
No warning for `f_rowtype`. In the same draft, warnings did appear for unqualified table names, function calls and a domain cast. Called as the app role:

```
ERROR: relation "customers" does not exist
```

`customers.name%type` isn't warned about either.

## Notes
The README's three fixes work here too: qualify it (`app.customers%rowtype`), or add `SET search_path`.
