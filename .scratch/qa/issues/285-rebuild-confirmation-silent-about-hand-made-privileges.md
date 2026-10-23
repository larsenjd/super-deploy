# 285: rebuild's confirmation doesn't say which hand-made grants, policies and row-level security it will lose

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** privs
**Round:** 3

## What I did
On `dev` (flagged disposable), with the dev server kept running as the README's "Connecting to dev" shows:

```sql
-- as super_deploy
create role app_report; grant usage on schema app to app_report;
-- as deployer
grant select on app.my_orders to app_report;
create policy p_dev on app.customers using (true);
alter table app.customers enable row level security;
```

`deploy-draft --target dev` (for a draft that recreates `my_orders`) warned before its YES, correctly:

```
Warning: view app.my_orders is recreated by draft my-orders-status: its grants of SELECT to app_report will be lost (default privileges don't restore them)
```

Then:

```sh
pnpm exec super-deploy rebuild --target dev --to 8
```

## Expected
`status`, `deploy` and `deploy-draft` now list the hand-made grants, revokes, policies and row-level security a migration will lose. So I expected `rebuild`'s confirmation, which recreates every object, to list them before asking for YES as well. The same applies to a shared QA database flagged disposable, where a DBA set them up.

## Actual
The confirmation lists the migrations, `Seed data is never loaded`, and `Not from any recorded migration, in schema app: column status of view app.my_orders`, with nothing about privileges. After YES, `relacl` is null on every relation, `pg_policies` is empty, and `customers.relrowsecurity` is false.

## Notes
The README's "Permissions" section does say `rebuild` drops everything "with the grants and policies on those objects", so this behaviour is documented. The point is only that the confirmation doesn't show it, unlike the other commands.
