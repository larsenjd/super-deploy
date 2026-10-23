# 289: FORCE ROW LEVEL SECURITY also fails a schema change that adds a foreign key to the table, which the README and the hint don't cover

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** privs
**Round:** 3

## What I did
On target `prod`, as the deploy role:

```sql
create policy customers_tenant on app.customers using (tenant = current_setting('app.tenant', true));
alter table app.customers enable row level security;
alter table app.customers force row level security;
insert into app.products (name) values ('p1');
```

In the desired schema, `products` gained:

```sql
  customer_id bigint not null default 1,
  constraint products_customer_fk foreign key (customer_id) references customers (id)
```

`draft` generated `ALTER TABLE ... ADD COLUMN ...` and `ALTER TABLE "app"."products" ADD CONSTRAINT "products_customer_fk" FOREIGN KEY (customer_id) REFERENCES app.customers(id);`. No scripts.

```sh
pnpm exec super-deploy finalize
pnpm exec super-deploy deploy --target prod
```

## Expected
The README ("With `FORCE ROW LEVEL SECURITY`") says the policies "would hide rows from a deployment's own scripts and from the materialized views it builds". This migration has neither, so I didn't expect it to be affected. Or, if it is, I expected the README and the error to say so and to give advice that fits.

## Actual
```
Error: data-model/migrations/00009-product-customer/schema-change.sql:6: PostgreSQL refused it: query would be affected by row-level security policy for table "customers". Hint: To disable the policy for the table's owner, use ALTER TABLE NO FORCE ROW LEVEL SECURITY. The deployment rolled back: target prod is unchanged, still at migration 00007-views. Next: table "customers" has FORCE ROW LEVEL SECURITY on the target, so its policies apply to the deploy role and would hide rows from this migration: turn it off while deploying (ALTER TABLE ... NO FORCE ROW LEVEL SECURITY, then FORCE again afterwards), or move the work out of the migration.
```

`NO FORCE`, deploy, then `FORCE` again worked. "Or move the work out of the migration" doesn't apply to a foreign key the desired schema declares.

## Notes
- I checked plain PostgreSQL on a scratch database, as the owner with `row_security` on: adding the same foreign key fails with a false `violates foreign key constraint`, because the forced policy hides the referenced rows. So failing loudly is better than that. Only the README and the hint are missing this case.
- Any table that references a tenant table with forced policies will hit this whenever a migration adds or re-adds such a foreign key.
