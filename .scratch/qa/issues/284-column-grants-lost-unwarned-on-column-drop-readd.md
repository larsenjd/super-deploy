# 284: Hand-made column-level grants are lost without a warning when a migration drops and re-adds the column

**Status:** needs-triage
**Category:** bug
**Severity:** low
**Area:** privs
**Round:** 3

## What I did
Target `qa` (`qa3_privs_qa`), deployed as `qa3_privs_deploy`, with default privileges set up as the README's "Permissions" recipe shows. By hand, as the deploy role:

```sql
grant update (note) on app.orders to qa3_privs_report;
grant select on app.order_counts to qa3_privs_report;   -- a materialized view
revoke select on app.my_orders from qa3_privs_reader;   -- a view
```

Desired-schema change: `note text` became `note text collate "C"`. `my_orders` gained a column in the middle, and `order_counts` gained a column. `draft` generated:

```sql
DROP MATERIALIZED VIEW "app"."order_counts";
DROP VIEW "app"."my_orders";
ALTER TABLE "app"."orders" DROP COLUMN "note";
ALTER TABLE "app"."orders" ADD COLUMN "note" text COLLATE pg_catalog."C";
CREATE VIEW ...; CREATE MATERIALIZED VIEW ...;
```

```sh
pnpm exec super-deploy finalize --acknowledge-destructive
pnpm exec super-deploy status --target qa
pnpm exec super-deploy deploy --target qa
```

## Expected
Warnings for everything the migration drops by name whose hand-made privileges default privileges won't restore, the dropped and re-added column included. Or the README should say that column grants are lost and not warned about.

## Actual
`status` and `deploy` warn about the two views only:

```
warning: materialized view app.order_counts is recreated by 00008-recreate-more: its grants of SELECT to qa3_privs_report will be lost (default privileges don't restore them)
warning: view app.my_orders is recreated by 00008-recreate-more: qa3_privs_reader regains SELECT, revoked on the target by hand (default privileges grant it again)
```

After the deploy, `pg_attribute.attacl` for `orders.note` was `{qa3_privs_report=w/...}` before and is empty after. As `qa3_privs_report`, `update app.orders set note='x' where false` now fails with `permission denied for table orders`.

## Notes
- The README ("Things to know about grants and policies made by hand") talks about objects that are dropped and recreated. It doesn't mention columns, which `draft` drops and re-adds for a collation or generation-expression change ("Destructive changes").
- `draft`'s own warning about the collation change talks about lost values only.
