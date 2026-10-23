# 250: A history schema damaged by hand is treated as "not super-deploy's": the advice is to drop it, and `status` reports 0 migrations and total drift

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** fail
**Round:** 3

## What I did
Target `qa` (managed schema `public`, deploy role `qa3_fail_deployer`) with 5 migrations deployed and 2 pending, `Drift: none`. As `postgres`, one hand change to the history schema:

```sql
alter table deployment_history.settings rename to settings_x;
```

```sh
pnpm exec super-deploy deploy --target qa
pnpm exec super-deploy status --target qa
```

(Renaming it back restores everything: `status` shows `5 migrations recorded, 2 pending`, `Drift: none`.)

## Expected
A message that the target's super-deploy history schema is damaged or incomplete (naming what is missing, here table `settings`), saying to repair it (or restore it from a backup), and warning that it holds the target's deployment record. Above all, no advice to drop it.

## Actual
`deploy`:

```
Error: Cannot use the history schema on target qa: the history schema "deployment_history" exists but super-deploy didn't make it: it holds sequence deployment_history.attempts_id_seq, table deployment_history.attempts, table deployment_history.deployed_draft, table deployment_history.migrations, table deployment_history.settings_x (drop it, or set historySchema in super-deploy.config.ts to a schema the target doesn't have)
```

`status` (exit 1):

```
Target qa: 0 migrations recorded, 7 pending
Deploy would refuse:
  the history schema "deployment_history" exists but super-deploy didn't make it: ... (drop it, or set historySchema ...)
Drift (the target differs from its recorded migrations):
  index public.items_pkey:
  ... (44 "only on the target" lines)
Error: Target qa has drifted from its recorded migrations: index public.items_pkey (only on the target), ... and 10 more. Deployments refuse until it matches them again. If its changes are those of the next pending migration applied by hand, mark --target qa records that migration as deployed (see the README, "Drift")
```

- The schema it calls "not super-deploy's" holds super-deploy's own `attempts`, `migrations` and `deployed_draft` tables, the target's only record of its 5 migrations. Following "drop it" deletes that record.
- Changing `historySchema`, the other suggestion, makes super-deploy treat the target as new, with 7 pending migrations whose objects already exist.
- `status` then reports every deployed object as drift and suggests `mark`.

## Notes
README, "Project settings", `historySchema`: "If a target already has a schema of that name, it must be super-deploy's, or empty and owned by the deploy role ... Every command refuses any other, naming what it holds: drop it, or choose another name here." That advice is right for a stranger's schema with the same name. It is wrong for super-deploy's own schema with one table renamed or missing, which a well-meant cleanup by hand, or a partial restore, can produce.
