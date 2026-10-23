# 288: A trigger that reads an external schema blocks later scripts, and neither the README nor the error gives a way forward

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** privs
**Round:** 3

## What I did
`externalSchemas: ["auth"]`, and in the desired schema (finalized as `00004-notes-trigger`):

```sql
create function notes_check_user() returns trigger language plpgsql as $$
begin
  if not exists (select from auth.users where id = 1) then
    raise exception 'no user';
  end if;
  return new;
end
$$;
create trigger notes_user before insert on notes for each row execute function notes_check_user();
```

Next draft (`notes kind`), with `post-migration.sql`:

```sql
insert into notes (body, kind) values ('welcome', 'system');
```

```sh
pnpm exec super-deploy rehearse
```

## Expected
The README ("External schemas") says this fails every rehearsal, and that "such a trigger also blocks every later migration whose scripts write to its table". I expected it, or the error, to say what to do when a migration has to write to that table.

## Actual
```
Error: data-model/draft/post-migration.sql:1: PostgreSQL refused it: relation "auth.users" does not exist. This failed in a rehearsal: it reads external schema "auth", which rehearsals don't contain, so a migration's scripts and seed data must not run anything that reads it, such as a trigger on a table they write (see the README, "Permissions").
```

It fails as documented. But nothing says how to get the row in. What worked was turning the trigger off around the write in `pre-migration.sql`:

```sql
alter table notes disable trigger notes_user;
insert into notes (body) values ('welcome');
alter table notes enable trigger notes_user;
```

That rehearsed, finalized and deployed to targets with and without `auth`.

## Notes
I don't know whether that is the intended workaround: it locks the table and skips the trigger's check on every target. Others would be guarding the trigger's read with `to_regclass('auth.users')`, or doing the write by hand. The README should name the recommended one.
