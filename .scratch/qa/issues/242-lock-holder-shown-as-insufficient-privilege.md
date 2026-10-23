# 242: The session blocking a deployment shows as `<insufficient privilege>` for a non-superuser deploy role

**Status:** needs-triage
**Category:** docs
**Severity:** medium
**Area:** fail
**Round:** 3

## What I did
Target `qa` deployed as a plain login role set up per the README's "Permissions" (not a superuser, no extra roles):

```sql
-- as postgres
create role qa3_fail_deployer login password 'dep';
create database qa3_fail_main;
grant create, connect on database qa3_fail_main to qa3_fail_deployer;
```

```ts
qa: { adapter: postgresTarget({ env: "QA_DATABASE_URL" }), lockTimeout: "20s" },
```

with `QA_DATABASE_URL=postgres://qa3_fail_deployer:dep@localhost:54818/qa3_fail_main`, `managedSchema: "app"`, and a pending migration that does `ALTER TABLE app.customers ADD COLUMN ...`.

From another session, as `postgres`, with `application_name = 'qa3-fail-holder'`: `begin; select * from app.customers;` and keep it open. Then:

```sh
pnpm exec super-deploy deploy --target qa &
sleep 5; pnpm exec super-deploy status --target qa
pnpm exec super-deploy deploy --target qa   # a second deploy meanwhile
```

## Expected
README, "Targets": `status` shows the wait "as `waiting for a lock held by server process N`, with that session's application name, user, state and statement", and the lock-timeout error says to "query `pg_stat_activity` for `pg_blocking_pids(<server process>)`" to find the blocker.

## Actual
`status` and the second deploy's refusal:

```
Locked by attempt #5 (deploy by jonathanl, ..., server process 4145174, active, statement started ...: ALTER TABLE "app"."customers" ADD COLUMN "tier" text NOT NULL DEFAULT 'basic'::text), waiting for a lock held by server process 4145116 (qa3-fail-holder, postgres: <insufficient privilege>)
```

There is no state and no statement, only PostgreSQL's raw `<insufficient privilege>`. Running the suggested `pg_stat_activity` query as the deploy role gives the same:

```
[{"pid":105251,"usename":"postgres","application_name":"qa3-fail-holder","state":null,"query":"<insufficient privilege>"}]
```

## Notes
PostgreSQL shows other roles' `state` and `query` only to superusers and members of `pg_read_all_stats` (or `pg_monitor`). In practice the blocker is usually the application's role or a DBA, never the deploy role, so with the README's setup the documented details never show. Either "Permissions" should say to grant `pg_read_all_stats` to the deploy role (or run the query as a superuser), or the CLI should say why the statement is hidden and what to do, instead of printing `<insufficient privilege>`.

Also, the second deploy's refusal ends with "if it is known to be dead, end its session with select pg_terminate_backend(4145174)", the waiting deploy's session, even though it has just said that the deploy is waiting on server process 4145116.
