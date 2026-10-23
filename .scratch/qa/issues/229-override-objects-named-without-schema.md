# 229: Adoption names override-needing functions without their schema, unlike every other refusal

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** adopt
**Round:** 3

## What I did
Managed schema `app`. The deploy role doesn't own anything yet:

```sql
create function app.count_rows(tbl text) returns bigint language plpgsql as $$ declare n bigint; begin execute format('select count(*) from app.%I', tbl) into n; return n; end $$;
create function app.notify_order() returns trigger language plpgsql as $$ begin perform pg_notify('orders', new.id::text); return new; end $$;
```

```sh
pnpm exec super-deploy init --adopt qa </dev/null
```

## Expected
Each object is named the same way in every list, as the README says ("Each
object is named as PostgreSQL names it (`table app.users`)").

## Actual
In one output, the same function is named two ways:

```
  function app.count_rows(tbl text) (owned by postgres)
  ...
  ALTER FUNCTION app.count_rows(tbl text) OWNER TO qa3_adopt_deploy;
Target qa has 2 objects that need an override reason, asked only in a terminal:
  function count_rows(text)
```

The terminal question (`Reason to override plpgsql-dynamic-sql for function
count_rows(text)?`), the `override:` lines and `metadata.json` (`"object":
"function count_rows(text)"`) all leave out the schema. Hard refusals do name the schema. On another
target (`qa3_adopt_ovr`), one run refused a procedure with `COMMIT` as
`function ovr.batch()`, then listed `function both_risks(text), function
reset_ids()` as needing override reasons.

## Notes
This is cosmetic for one managed schema, but the override record is meant to be
read by reviewers, and the inconsistency makes the lists harder to match
against each other.
