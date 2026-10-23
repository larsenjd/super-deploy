# 207: `deploy` on a new target reports its permission problems one at a time, while `status` lists them all

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** newproj
**Round:** 3

## What I did
A new database owned by `postgres`, a deploy role with no privileges on it, managed schema `public`:

```sh
node ~/.local/share/super-deploy-qa/sql.mjs postgres "create database qa3_newproj_stage"
# config: stage: { adapter: postgresTarget({ env: "STAGE_DATABASE_URL" }) }
export STAGE_DATABASE_URL=postgres://qa3_newproj_deploy:dpw@localhost:54818/qa3_newproj_stage
pnpm exec super-deploy status --target stage
pnpm exec super-deploy deploy --target stage
# apply the one fix deploy named:
node ~/.local/share/super-deploy-qa/sql.mjs qa3_newproj_stage "GRANT CREATE ON DATABASE qa3_newproj_stage TO qa3_newproj_deploy"
pnpm exec super-deploy deploy --target stage
```

## Expected
`deploy` names every pre-flight problem with its fix, like `status` does, so the DBA can fix them in one go.

## Actual
`status` lists both:

```
Deploy would refuse:
  the deploy role qa3_newproj_deploy needs CREATE on database qa3_newproj_stage to create the history schema "deployment_history" (fix: GRANT CREATE ON DATABASE qa3_newproj_stage TO qa3_newproj_deploy)
  schema public is owned by pg_database_owner (the owner of database qa3_newproj_stage, postgres), whose privileges the deploy role doesn't have (fix: ALTER DATABASE qa3_newproj_stage OWNER TO qa3_newproj_deploy)
```

The first `deploy` names only the first:

```
Error: Cannot create the history schema on target stage: the deploy role qa3_newproj_deploy needs CREATE on database qa3_newproj_stage to create the history schema "deployment_history" (fix: GRANT CREATE ON DATABASE qa3_newproj_stage TO qa3_newproj_deploy)
```

and only after that is fixed does the second `deploy` name the ownership problem (by then it has also created the `deployment_history` schema, although it deployed nothing):

```
The deploy role on target stage doesn't own 1 object in the managed schema:
  schema public (owned by pg_database_owner (the owner of database qa3_newproj_stage, postgres))
To fix, run as a superuser:
  ALTER DATABASE qa3_newproj_stage OWNER TO qa3_newproj_deploy;
Error: Target stage failed the deploy pre-flight checks (1 finding, listed above)
```

## Notes
On a real target each round trip is a ticket to the DBA. With both fixes applied the deploy of 11 migrations went through first time.
