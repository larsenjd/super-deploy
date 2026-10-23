# 227: An adoption that loses a race with another is told to "restore 00001-adopt from version control"

**Status:** needs-triage
**Category:** bug
**Severity:** low
**Area:** adopt
**Round:** 3

## What I did
Two colleagues adopt the same target from two copies of a project (`p12a`,
`p12b`). The target's managed schema `r` holds a function that needs an
override reason:

```sql
create schema r;
create table r.t (id int primary key);
create function r.f() returns void language plpgsql as $$ begin perform pg_notify('a','b'); end $$;
```

1. In `p12a`, in a terminal: `pnpm exec super-deploy init --adopt qa`. It
   stops at `Reason to override denylisted-call for function f()?`.
2. Meanwhile, in `p12b`, in a terminal: `pnpm exec super-deploy init --adopt qa`.
   I answered `from B`, and it adopted the target.
3. Back in `p12a`, I answered `from A`.

## Expected
`p12a` refuses, saying that target qa was adopted by another run while it was
asking (attempt #1, by whom and when), that nothing was written, and what to do:
take the other project's migration instead of adopting again.

## Actual
```
Error: Target qa's recorded migrations don't match the project's: the target records migration 00001-adopt with content hash e20055c8..., but the repo's is 9e4cc183...: restore 00001-adopt (and index.json) from version control (a migration a target has recorded must never change, so put new changes in a new migration)
```

`p12a` has no `00001-adopt`. It wrote nothing (good), and there is nothing to
restore from version control. The message describes an edited migration,
which isn't what happened.

## Notes
The data is safe: nothing was written in `p12a`, and the target keeps B's
adoption. Only the message is wrong.
