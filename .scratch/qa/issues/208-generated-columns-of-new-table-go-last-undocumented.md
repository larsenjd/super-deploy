# 208: A new table's stored generated columns are added after its other columns, which "Column order" doesn't list

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** newproj
**Round:** 3

## What I did
```sh
node <repo>/packages/super-deploy/dist/cli.js init && git init && pnpm install
cat > data-model/desired-schema/a.sql <<'SQL'
create table a (
  id bigint generated always as identity primary key,
  price numeric(10,2) not null,
  qty integer not null,
  total numeric generated always as (price * qty) stored,
  note text
);
SQL
pnpm exec super-deploy draft --name one
cat data-model/draft/schema-change.sql
```

## Expected
README, "Column order": "A new table gets its columns in the declared order, except a column whose type (a domain or a composite type) or default (a function) is created in the same migration". `total` uses only built-in types and operators, so it should stay between `qty` and `note`.

## Actual
```sql
CREATE TABLE "public"."a" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "price" numeric(10,2) NOT NULL, "qty" integer NOT NULL, "note" text, CONSTRAINT "a_pkey" PRIMARY KEY (id));

ALTER TABLE "public"."a" ADD COLUMN "total" numeric GENERATED ALWAYS AS ((price * (qty)::numeric)) STORED;
```

`total` ends up after `note`, on `dev`, rehearsals and every target. No warning.

## Notes
Column order is never compared, so nothing breaks; but the README's list of exceptions is presented as complete. Add "a stored generated column" to it (or keep it in place in `CREATE TABLE` when its expression only uses columns of the same table).
