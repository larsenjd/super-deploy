# 281: LEAKPROOF and superuser-only SET options pass rehearsal but fail every deploy, dev included

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** privs
**Round:** 3

## What I did
In a project with `managedSchema: "app"`, I added this to the desired schema:

```sql
create function same_tenant(a text, b text) returns boolean
language sql immutable leakproof
as $$ select a = b $$;
```

```sh
pnpm exec super-deploy draft --name leakproof
pnpm exec super-deploy finalize
pnpm exec super-deploy deploy --target noauth   # postgresTarget, non-superuser deploy role
pnpm exec super-deploy deploy --target dev
```

Then the same with a routine option for a superuser-only setting:

```sql
create function bulk_load_notes() returns void
language plpgsql
set session_replication_role = replica
as $$
begin
  insert into app.notes (body) values ('bulk');
end
$$;
```

## Expected
The README's "Supported" list includes `LEAKPROOF` and `SET` among routine options. A migration that `draft` and `finalize` rehearse successfully should deploy to a target whose deploy role is set up as "Permissions" describes, and at least to `dev`. Otherwise the option should be refused at `draft`, with the reason.

## Actual
`draft` and `finalize` succeed. Every deployment fails, `dev` included (its `deployer` isn't a superuser):

```
Error: data-model/migrations/00009-leakproof/schema-change.sql:4: PostgreSQL refused it: only superuser can define a leakproof function. The deployment rolled back: target noauth is unchanged, still at migration 00005-notes-kind.
Error: data-model/migrations/00009-leakproof/schema-change.sql:4: PostgreSQL refused it: only superuser can define a leakproof function. The deployment rolled back: target dev is unchanged, with no migration recorded.
Error: data-model/migrations/00009-bulk-load/schema-change.sql:4: PostgreSQL refused it: permission denied to set parameter "session_replication_role". The deployment rolled back: target noauth is unchanged, still at migration 00005-notes-kind.
```

The migration is finalized and can't deploy anywhere. I could recover only because no target had recorded it, so I could `unfinalize` it.

## Notes
- Guess: rehearsals run as the rehearsal server's superuser (`super_deploy`, per the README), so anything that needs superuser passes there. Running rehearsals as a non-superuser role, or refusing `LEAKPROOF` and SET options for superuser-only parameters, would catch this before `finalize`.
- `session_replication_role = replica` also turns off triggers, foreign-key checks included, so it is privilege-like in itself.
- A routine's `SET role = <role the deploy role isn't a member of>` fails the same way (see 280).
