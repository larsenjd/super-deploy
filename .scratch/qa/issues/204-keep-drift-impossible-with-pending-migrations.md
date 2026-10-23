# 204: The README's "Keep it" way out of drift doesn't work when the target already has a pending migration

**Status:** needs-triage
**Category:** docs
**Severity:** medium
**Area:** newproj
**Round:** 3

## What I did
Project with migrations 00001-00006 deployed to a real target `qa`, and 00007 (`alter table shipments add column weight_kg numeric(8,3)`) finalized but not yet deployed there. Someone changes `qa` by hand, as the deploy role:

```sql
create index shipments_carrier_idx on shipments (carrier);
alter table customers add column vip boolean;
```

`status --target qa` and `deploy --target qa` report the drift. Following README "Drift", **Keep it**: "Make the desired schema describe the target as it now is ..., then `draft` and `finalize` a migration, and run `mark --target X`":

```sh
# add "vip boolean," to customers and the index to shipments.sql
pnpm exec super-deploy draft --name "keep qa drift"
pnpm exec super-deploy finalize                 # 00008-keep-qa-drift
pnpm exec super-deploy mark --target qa         # in a terminal
```

## Expected
Either it works, or the README says what to do when the target has pending migrations before the new one.

## Actual
`mark` always marks the *next pending* migration (00007), and needs the target to match a replica up to 00007 exactly, which a drifted target never does:

```
Error: Target qa does not match a replica of its migrations up to 00007-add-weight: column vip of table public.customers (only on the target), column weight_kg of table public.shipments (missing from the target), index public.shipments_carrier_idx (only on the target). Nothing was recorded; fix the target until it matches, then mark again
```

Applying 00007 by hand as well (`alter table shipments add column weight_kg ...`) doesn't help: the vip column and index are still "only on the target" for 00007. `deploy` refuses because of the drift. The only way out was to undo the drift (README's "Undo it"), mark or deploy 00007, then deploy 00008, i.e. "Keep it" is not available at all while anything is pending.

## Notes
- README section: "Drift", the "Keep it" bullet, and "Disposable targets and the guarded commands" (`mark`).
- The `mark` error's "fix the target until it matches" doesn't say that this means undoing the changes you wanted to keep.
- Suggest: say in "Keep it" that it works only when the target has no pending migrations; otherwise undo the change, deploy the pending migrations, then re-apply it by hand and `mark` the new migration (or just deploy it).
