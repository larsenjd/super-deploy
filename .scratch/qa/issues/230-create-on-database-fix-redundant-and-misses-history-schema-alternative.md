# 230: The CREATE-on-database fix is redundant after ALTER DATABASE OWNER, and never offers the pre-created history schema

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** adopt
**Round:** 3

## What I did
**Public schema.** Database `qa3_adopt_pub` is owned by `qa3_adopt_legacy`.
The managed schema is `public` and the deploy role is `qa3_adopt_pubdeploy`:

```sh
pnpm exec super-deploy init --adopt qa </dev/null
```

**Named schema.** On `qa3_adopt_hist`, the deploy role owns `app2`, but has no
CREATE on the database and no history schema. I set `historySchema: "dh2"`:

```sh
pnpm exec super-deploy init --adopt qa </dev/null
```

## Expected
- For `public`, the fix script makes the deploy role the database's owner,
  which already gives it CREATE, so no separate GRANT should be needed.
- The CREATE refusal mentions the README's alternative for a DBA who won't
  grant CREATE on the database: "a DBA may create both schemas beforehand, owned by the deploy
  role, e.g. `create schema deployment_history authorization deploy_role`".
  The round 3 change list says this is supported, and it works: I tested it on `qa3_adopt_app`.

## Actual
Public:

```
To fix, run as a superuser:
  ALTER DATABASE qa3_adopt_pub OWNER TO qa3_adopt_pubdeploy;
  ...
  GRANT CREATE ON DATABASE qa3_adopt_pub TO qa3_adopt_pubdeploy;
```

The `GRANT` is redundant once the first line has run. A DBA reviewing the
script may wonder why both are needed.

Named schema:

```
The deploy role qa3_adopt_deploy needs CREATE on database qa3_adopt_hist to create the history schema "dh2"
To fix, run as a superuser:
  GRANT CREATE ON DATABASE qa3_adopt_hist TO qa3_adopt_deploy;
Error: Cannot adopt target qa: the deploy role lacks CREATE on the database, listed above. Nothing was written; run the fixes as a superuser, then adopt again
```

Only the broad grant is offered. CREATE on the database lets the deploy role
create any schema.

## Notes
Suggestion: after the GRANT, add the alternative as a comment, e.g.
`-- or instead: CREATE SCHEMA dh2 AUTHORIZATION qa3_adopt_deploy;`. Leave out
the GRANT when the script already transfers the database.
