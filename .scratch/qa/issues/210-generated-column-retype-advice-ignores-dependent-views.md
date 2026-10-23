# 210: Advice to change a column in the pre-migration script ignores views that use it (generated-column retype, collation change)

**Status:** needs-triage
**Category:** docs
**Severity:** medium
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
create view a_totals as select id, total from a;
SQL
pnpm exec super-deploy draft --name one && pnpm exec super-deploy finalize
sed -i 's/qty integer/qty bigint/' data-model/desired-schema/a.sql
pnpm exec super-deploy draft --name retype
#   ... Next: drop generated column "total" in the pre-migration script and run draft again ...
echo 'alter table a drop column total;' > data-model/draft/pre-migration.sql
pnpm exec super-deploy draft
```

## Expected
The README section "Changing the type of a column a generated column uses" (and the warning) say what to do when something depends on the generated column.

## Actual
```
Error: data-model/draft/pre-migration.sql:1: PostgreSQL refused it: cannot drop column total of table a because other objects depend on it. Detail: view a_totals depends on column total of table a. Hint: Use DROP ... CASCADE to drop the dependent objects too.
```

What works is dropping the view first (`drop view a_totals;` then `alter table a drop column total;` in the pre-migration script): `draft` recreates the view in the schema change and the rehearsal matches. Nothing says so, and PostgreSQL's hint points to `CASCADE`, which the README says stays destructive.

## Notes
- Suggest one sentence in "Changing the type of a column a generated column uses": drop the views (and indexes) that use the generated column first; `draft` creates them again. Mention that a view dropped that way loses grants made by hand (`status` and `deploy` do warn about this, which I confirmed).
- Second instance, same cause: a **collation change** on a column a view uses. Desired schema change `display_name varchar(100) not null` to `display_name varchar(100) collate "C" not null`, where views `customer_order_totals` and `top_customers` (a view on that view) select `display_name`. `draft` warns and gives the in-place statement:

  ```
  warning: Column customers.display_name is dropped and re-added to change its collation (no non-null values in the rehearsal data): its values are lost. To keep them, change it in place in the pre-migration script: ALTER TABLE "public"."customers" ALTER COLUMN "display_name" TYPE character varying(100) COLLATE pg_catalog."C"
  ```

  Putting exactly that statement in `pre-migration.sql` and running `draft`:

  ```
  Error: data-model/draft/pre-migration.sql:1: PostgreSQL refused it: cannot alter type of a column used by a view or rule. Detail: rule _RETURN on view customer_order_totals depends on column "display_name".
  ```

  Again, dropping both views first (`drop view top_customers; drop view customer_order_totals;`) before the in-place statement works: `draft` recreates them and the rehearsal matches. The README's "Destructive changes" paragraph and the warning could say so, or the warning could include the `DROP VIEW` statements when the column has dependent views.
- In that collation case `draft` also adds "Column customers.display_name is added NOT NULL without a default (no rows in the rehearsal data): add and backfill it in the pre-migration script", which describes the drop/re-add, not anything the user did; it reads as a second, separate problem.
