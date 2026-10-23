# 201: A varchar column with an `IN (...)` check can never be finalized: the rehearsal "does not match the desired schema"

**Status:** needs-triage
**Category:** bug
**Severity:** high
**Area:** newproj
**Round:** 3

## What I did
From an empty directory:

```sh
node <repo>/packages/super-deploy/dist/cli.js init && git init && pnpm install
cat > data-model/desired-schema/t.sql <<'SQL'
create table t (
  id bigint generated always as identity primary key,
  status varchar(5) not null,
  constraint t_status_check check (status in ('new', 'paid'))
);
SQL
pnpm exec super-deploy draft --name one
pnpm exec super-deploy rehearse
```

The same happens in a later migration that narrows an existing `text` column with such a check to `varchar(n)` (my real project: `status text ... check (status in ('new','paid','shipped'))` changed to `status varchar(5)`).

## Expected
A plain `varchar` column with an `IN` list check, one of the most common table shapes, drafts, rehearses and finalizes.

## Actual
`draft` (exit 0) warns, and `rehearse` / `finalize` fail:

```
Created draft one: 1 statement in data-model/draft/schema-change.sql
warning: The generated schema change doesn't produce the desired schema: pg-delta can't generate the difference: make the change by hand in the pre-migration script
  pg-delta: ALTER TABLE "public"."t" DROP CONSTRAINT "t_status_check";
  pg-delta: ALTER TABLE "public"."t" ADD CONSTRAINT "t_status_check" CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'paid'::character varying])::text[])));
  catalog: from the migrations: constraint: t t_status_check c CHECK (((status)::text = ANY (ARRAY[('new'::character varying)::text, ('paid'::character varying)::text]))) deferrable=false deferred=false validated=true
  catalog: from the desired schema: constraint: t t_status_check c CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'paid'::character varying])::text[]))) deferrable=false deferred=false validated=true

Error: The rehearsal does not match the desired schema, and running draft again won't change that: pg-delta can't generate the difference: make the change by hand in the pre-migration script (4 differences, listed above)
```

The two constraints are the same check. PostgreSQL deparses `status in ('new','paid')` on a varchar column as `(ARRAY['new'::varchar, ...])::text[]`; re-parsing that text (which is what `schema-change.sql` contains) folds the array cast into each element, `ARRAY[('new'::varchar)::text, ...]`. So the generated statement can never reproduce the desired schema's text, and the comparison is textual.

In the narrowing case the warning also adds the irrelevant hint "(a column renamed in the pre-migration script needs its NOT NULL constraint renamed too: see the README, "Renaming a column")".

## Notes
- Workaround: write the check as `status::text in ('new', 'paid')` or `status = any (array['new', 'paid'])`; both rehearse cleanly. `status in ('new'::text, 'paid'::text)` fails the same way. Nothing in the output or the README points to this; the advice it gives ("make the change by hand in the pre-migration script") is wrong for a first migration and doesn't help for a later one.
- Guess: the comparison would need to normalise the desired schema by round-tripping its definitions through the same deparse/re-parse, or compare after re-applying, rather than comparing `pg_get_constraintdef` text from two different routes. Other expressions (index predicates, defaults, view bodies) on varchar columns may hit the same thing.
