# 287: The SET LOCAL ROLE refusal is tagged [escapes-transaction], which it doesn't

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** privs
**Round:** 3

## What I did
`data-model/draft/pre-migration.sql` (also tried in `post-migration.sql` and `seed-data.sql`):

```sql
set local role qa3_privs_reader;
set role qa3_privs_reader;
reset role;
set session authorization qa3_privs_reader;
```

```sh
pnpm exec super-deploy rehearse
```

## Expected
A reason that applies, and a rule tag that matches it. The other privilege refusals are `[unsupported-object]`.

## Actual
```
data-model/draft/pre-migration.sql:5: SET LOCAL ROLE is not allowed: a deployment runs everything as the deploy role, and roles and privileges are set up on targets outside super-deploy; remove it from the file, and run what needs another role on each target instead (see the README, "Permissions") [escapes-transaction]
```

The reason applies now, but the tag still says `escapes-transaction`. `SET LOCAL ROLE` ends with the transaction. The same tag is on `SET ROLE`, `RESET ROLE` and `SET SESSION AUTHORIZATION`. The README doesn't list the rule names, so the tag is the only hint a user gets about the rule's category.
