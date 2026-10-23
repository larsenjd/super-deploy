# 264: disposable asks for YES, then fails because the deploy role can't create the history schema

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** disp
**Round:** 3

## What I did
A new database on the shared server, owned by `postgres`, that the deploy role (`qa3_disp_deploy`, login, not superuser) can connect to but has no `CREATE` on:

```sh
node ~/.local/share/super-deploy-qa/sql.mjs postgres "create database qa3_disp_nocreate"
QA_DATABASE_URL=postgres://qa3_disp_deploy:dp@localhost:54818/qa3_disp_nocreate \
  pnpm exec super-deploy disposable --target qa --set yes     # in a terminal
```

## Expected
The command knows before asking that it will need to create `deployment_history` (the box says `Last recorded migration: none`), and README, Permissions, says the first deployment needs `CREATE` on the database. I expected it to refuse before asking for YES, as the guarded commands do for a locked target or an ownership problem.

## Actual
It shows the full confirmation box, I type `YES`, and only then:
```
Error: Cannot create the history schema on target qa: the deploy role qa3_disp_deploy needs CREATE on database qa3_disp_nocreate to create the history schema "deployment_history" (fix: GRANT CREATE ON DATABASE qa3_disp_nocreate TO qa3_disp_deploy)
```
(exit 1). The message itself is good.

## Notes
The README's Permissions section mentions `CREATE` only for "the first deployment"; `disposable` (and `mark`) on a never-deployed target also create the history schema, so they need it too.
