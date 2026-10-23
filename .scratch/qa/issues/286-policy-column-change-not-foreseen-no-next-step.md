# 286: A column change a hand-made policy blocks isn't foreseen by status, and deploy's error gives no next step

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** privs
**Round:** 3

## What I did
On target `qa`, as the deploy role:

```sql
create policy orders_tenant on app.orders using (tenant = current_setting('app.tenant', true));
alter table app.orders enable row level security;
```

Desired schema: `tenant text not null` became `tenant varchar(40) not null`. Then `draft`, `finalize --acknowledge-destructive`, and:

```sh
pnpm exec super-deploy status --target qa
pnpm exec super-deploy deploy --target qa
```

## Expected
The README ("Things to know about grants and policies made by hand") says this fails at deploy and that PostgreSQL's error names the policy. It does. But `status` and `deploy` already read the target's policies to warn about recreated objects, so I expected `status` to warn that `00005-tenant-varchar` changes a column the policy `orders_tenant` uses. I also expected the error to say what to do, as the FORCE ROW LEVEL SECURITY error does with its `Next:`.

## Actual
`status` shows `Drift: none` and the pending migration, with no warning. The deploy then fails:

```
Error: data-model/migrations/00005-tenant-varchar/schema-change.sql:6: PostgreSQL refused it: cannot alter type of a column used in a policy definition. Detail: policy orders_tenant on table orders depends on column "tenant". The deployment rolled back: target qa is unchanged, still at migration 00004-recreate-view-fn.
```

The README's way out (drop the policy, deploy, create it again) worked.

## Notes
- For comparison, the FORCE ROW LEVEL SECURITY failure ends with `Next: table "orders" has FORCE ROW LEVEL SECURITY on the target ... turn it off while deploying ...`.
- Unrelated detail: `draft` generated `ALTER TABLE "app"."orders" ALTER COLUMN "tenant" DROP DEFAULT;` before the type change, though `tenant` has no default.
