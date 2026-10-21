# Exploratory QA

How to run a round of agent QA on super-deploy: several testers use the built CLI the way a new user would, each in one area, and write every problem they find as an issue in `issues/`. Nobody fixes anything during a round. The issues then go to `/triage`.

Rounds 1 (2026-10-20, issues 01–68) and 2 (2026-10-21, issues 101–190) are triaged and fixed. Round 3 numbers from 201.

## Running a round (for the orchestrator)

1. Check `main` builds: `pnpm build` at the repo root. Testers use `packages/super-deploy/dist/cli.js`.
2. Check the shared server is up: `node ~/.local/share/super-deploy-qa/sql.mjs postgres "select 1"`. If it isn't, start it with the line in `~/.local/share/super-deploy-qa/README.md`. Never stop it during a round.
3. Pick the round number `R` and give each area its issue range (below).
4. Start one background subagent per area, all at once. Each prompt is the **Tester brief** below with `<R>`, `<area>` and `<range>` filled in, followed by that area's section from **Areas**.
5. As each finishes, relay its report to the user: issue count, the high-severity ones, and anything it couldn't test. Don't verify the findings yourself; `/triage` does.
6. When all have finished, list the issues by severity and suggest `/triage .scratch/qa/issues — round <R> (issues <first>–<last>)`.

Ranges: round `R` uses `R01`–`R99`. Round 3: `newproj` 201–219, `adopt` 220–239, `fail` 240–259, `disp` 260–279, `privs` 280–299.

## Tester brief

> You are an exploratory tester for super-deploy, a CLI that deploys PostgreSQL 18 schema changes as immutable, all-or-nothing migrations generated from a declared schema. Act as a new user. Find what's broken, confusing or undocumented, and write each problem up as an issue. Do NOT fix anything.
>
> This is QA round `<R>`, area `<area>`, issue numbers `<range>`. Your area is described at the end.
>
> **Test it the way a user would.**
> - Read about the tool only from its user documentation and its output:
>   - `/home/jonathanl/.t3/projects/super-deploy/packages/template/README.md`, which `init` also copies into each project;
>   - `--help`;
>   - the files it writes;
>   - its messages.
> - Do NOT read the tool's source, tests, spec, ADRs, earlier QA issues, or anything else in `/home/jonathanl/.t3/projects/super-deploy`, except writing your own issue files.
> - Never read other repositories or project directories on this machine. If the docs don't tell you how to do something, that's a finding.
>
> **Where to work.**
> - Work inside `/tmp/sd-qa<R>/<area>/` only (create it). Never edit anything in the repo except your issue files.
> - The CLI is built at `/home/jonathanl/.t3/projects/super-deploy/packages/super-deploy/dist/cli.js`. Create projects with `node <that path> init` (work out its usage from `--help`). Inside a project, use `pnpm exec super-deploy …` as the README says.
> - Your shell is zsh. Quote globs and words starting with `=`.
>
> **The shared database server**, standing in for a real long-running server (QA, production):
> - Embedded PostgreSQL 18.4, running permanently at `postgres://postgres:qa@localhost:54818/<database>`. The superuser is `postgres`, password `qa`. Notes are in `~/.local/share/super-deploy-qa/README.md`.
> - There is no psql. Run SQL with `node ~/.local/share/super-deploy-qa/sql.mjs <database> "<sql>"`. For a session that must stay open (e.g. holding a lock), write a small node script in your work folder that requires `pg` the same way `sql.mjs` does.
> - Other testers use it at the same time. So:
>   - create only databases named `qa<R>_<area>_*`;
>   - prefix every role you create with `qa<R>_<area>_` (roles are cluster-wide);
>   - never touch other databases or roles;
>   - never stop, restart or reconfigure the server, and never kill a postgres process.
>
>   Leave your databases in place when you finish.
> - Add real targets pointing at your databases on this server the way the README says, with connection strings from environment variables. Where it makes sense, deploy as a non-superuser login role set up as the README's "Permissions" section asks. Setting that up from the docs is part of the test.
>
> **Your projects' own servers.**
> - Each project runs private embedded servers of its own: `dev`, and the rehearsal server. Use them as the README describes.
> - Kill only processes you started, and by pid, never by name or pattern: other testers run the same commands.
> - When you finish, check that none of your projects' embedded servers is still running. If one is, note it as a finding, then stop it by its data directory.
>
> **Terminals.**
> - Commands that need a terminal (type YES, questions, the menu) must run in a pseudo-terminal. Use Python's `pty` module (scripts in `/tmp/sd-qa<R>/<area>/scripts/`, run with `python3 -I`) or `script -qfc`.
> - Wait for each prompt before typing.
> - For signals, start the CLI in the background, wait for the moment you want, then signal its pid or its process group.
>
> **What counts as a finding:**
> - **Bugs:** wrong results, crashes, stack traces, hangs, a database or project left in a bad state, a guard that lets something through.
> - **Docs:** the README is wrong, misleading or missing a step; `--help` disagrees with behaviour; a message doesn't say what happened or what to do next.
> - **Rough edges:** surprising behaviour, a confusing prompt.
>
> Reproduce each finding once before writing it up. Check the README: if the behaviour is intended, file it only if the docs are unclear.
>
> **Writing issues.** One file per finding: `/home/jonathanl/.t3/projects/super-deploy/.scratch/qa/issues/<NNN>-<slug>.md`. NNN is a three-digit number from your range; the slug is kebab-case. Before writing, list the folder and skip numbers that are taken. Use this format:
>
> ```
> # <NNN>: <one-line title>
>
> **Status:** needs-triage
> **Category:** bug | docs | enhancement
> **Severity:** high | medium | low
> **Area:** <area>
> **Round:** <R>
>
> ## What I did
> <exact commands, config and SQL, enough to reproduce from an empty directory>
>
> ## Expected
> ## Actual
> <exact output, trimmed to what matters>
>
> ## Notes
> <optional: workaround, README section involved, guesses clearly marked as guesses>
> ```
>
> **Report back** when you've covered your area, or after about 2 hours of work:
> - the issue files you wrote (number, title, severity);
> - what you covered;
> - what you couldn't test and why;
> - what worked notably well;
> - the databases, roles and projects you left in place.

## Areas

Each section is appended to the tester brief. "Changed since round 2" lists what to press hardest, because no tester has used it yet. Each item says what a round 2 fix set out to change; check the result against the README and `--help`, not against this list.

### newproj: a new project, start to finish

Run the getting-started path and keep going through several migrations:
- `init` a project, then `git init` and `pnpm install`.
- A desired schema with tables, constraints, indexes, a view, functions, a trigger, a domain and a composite type.
- `draft`, `rehearse`, `finalize`, `deploy --target dev`, `status` and `validate`.
- Changes:
  - add, rename and drop columns (including a rename that needs a pre-migration script);
  - change a type;
  - a destructive change;
  - seed data;
  - edit the draft, discard it, unfinalize, restore-schema;
  - reorder a composite type's attributes.
- Deploy to a real target on the shared server. Use the interactive menu too.

Changed since round 2:
- **`draft` checks its own output:** it applies the generated schema change and warns when it fails or doesn't produce the desired schema. Try reordering a composite type's attributes, and changing the type of a column a generated column uses.
- **Changes pg-delta can't express in place now say what to do:**
  - a collation or generated-expression change drops and re-adds the column, and the warning gives the in-place statement;
  - columns whose type, domain or default is created in the same migration go last, as the README says.
- **Comments on view and materialized-view columns** are refused.
- **A hand-edited `schema-change.sql`:** warned about at `rehearse` and `finalize`. The finalized migration records it and holds a `HAND-EDITED.md` diff, and `validate` lists it. Check the diff is right and readable in a PR.
- **`unfinalize`** warns before moving the migration.
- **The narrowing warning** with no rehearsal data.
- **Projects in a subfolder of an existing Git repo:** the pre-commit hook.
- **`finalize` and `discard-draft` run at the same time.**
- **The README** now explains drift and how to clear it, and what `dev` is (it isn't disposable).
- **`status`** says when it checked for drift and found none.
- **Ctrl+C during `deploy`:** a closing line says what happened to the target.

### adopt: adopting an existing database

Build realistic existing databases by hand with SQL, then bring them under management with `init --adopt`:
- a named managed schema, and one using `public`;
- foreign keys, indexes, views, functions and triggers;
- domain-typed columns, function defaults and generated columns;
- functions that need an override marker (dynamic SQL, `pg_notify`); adopt in a terminal and answer the override-reason questions;
- objects super-deploy refuses, to see the refusal;
- a typo in the managed schema name.

After adoption: `status`, `validate`, then draft, finalize and deploy a change to the adopted target.

Changed since round 2:
- **One refusal list:** ownership, CREATE on the database and unsupported objects together. Each refused object is named by object, with the full statement part that's refused, and the ownership fixes are one per line (with the right fix for `public`).
- **Empty managed schema:** adoption succeeds but warns `Adopted 0 objects` and names other schemas that hold objects. Try a typo or mixed-case name for `managedSchema` too: the "does not exist" refusal lists the target's schemas.
- **Starting over:** the README documents how to undo an adoption, and the refusals point to it. Follow it.
- **A pre-created history schema:** an empty one owned by the deploy role is accepted, so a DBA can create it instead of granting CREATE on the database. Any other is refused clearly.
- **What adoption leaves on the target:** the summary covers row-level security and default privileges too, and it mentions objects in other schemas that depend on the managed schema.
- **Without a terminal:** functions that only need an override reason are reported as such, not as unsupported.
- **Locks:** adoption blocked by a lock gives a clear error, and Ctrl+C stops it promptly.
- **Comments on view columns** are refused under a rule, with the fix.

### fail: things going wrong

Set up a project with a few migrations deployed to a shared-server target, then break things:
- **Drift:** change the target by hand.
- **Locks:** hold a lock from another session while deploying, and run two deploys at once.
- **Failing scripts:** a script that fails on real data, fixed with a Recovery.
- **Interruptions:** Ctrl+C and SIGTERM during `deploy`, `finalize` and a rehearsal; SIGKILL mid-deploy, then `status` and the next `deploy`.
- **Tampering:** edit a finalized migration.
- **Bad input:** a broken config file, bad and unset connection strings, a target whose server is down (use a port nothing listens on), an unreachable host, SQL errors.
- **Output:** exit codes, stdout vs stderr, `--debug`, and piping into `head`.

Changed since round 2:
- **Signals through `pnpm exec`:**
  - SIGTERM must stop the deployment, not let it commit;
  - closing the terminal must clean up (no embedded server left running);
  - the same signal twice within about 1 s counts once;
  - an interrupt arriving after the command finished must not print success and then "Interrupted".
- **What happened to the target:** after Ctrl+C, or when the server ends the deploy's session, the CLI says it rolled back.
- **A deploy whose client stops responding** must not hold table locks indefinitely.
- **Locks:**
  - timeout messages quote the configured `lockTimeout`/`statementTimeout`;
  - `status` and the lock refusal name what the holding session is waiting on;
  - the lock-timeout error says how to find the blocker.
- **TLS:** a missing or unreadable `sslrootcert`, and invalid `sslmode` values.
- **An edited finalized migration:** the error says how to restore it, and `validate` prints it once.
- **`super-deploy.config.ts`** that throws at run time: is the location given?
- **Drift output** with multi-line definitions (views, functions).
- **A stale or damaged `.super-deploy/` server folder:** the error says how to recover.

### disp: disposable targets and the guarded commands

Work out from `--help` and the README what a disposable target is. Exercise `disposable`, `deploy-draft` (with and without seed data), `rebuild --to N` and `mark` on shared-server targets, both disposable and not. Run every guarded command without a terminal, on a non-disposable target, with answers other than YES, with Ctrl+C and Ctrl+D at the prompt, and with the target changed while the prompt waits.

Changed since round 2:
- **`rebuild --to 0`** resets a disposable target to no migrations, e.g. to retry a first draft or a Recovery of migration 1.
- **The confirmation boxes:**
  - `Host:` shows the configured host with the server's address in brackets, next to the target name;
  - `rebuild`'s list names an inheriting table's lost rows and a domain constraint's domain, and shows which migrations run as Recoveries;
  - `mark`'s box says when a migration's data scripts will never run.
- **Ownership:**
  - `rebuild` refuses a managed schema the deploy role doesn't own, like `deploy`;
  - its refusal for a superuser's extension gives a fix that works;
  - `mark` re-checks ownership after YES.
- **Disposable flag:**
  - the menu preselects "no" and shows the current flag;
  - the attempt log says which way it was set;
  - flagging a target that holds a deployed draft as not disposable warns first.
- **`deploy-draft`:**
  - refuses before asking while another attempt holds the target;
  - says the target rolled back when it fails;
  - shows a hand-edited schema change in its box.

### privs: privileges set up outside super-deploy

The README's "Permissions" section says super-deploy declares no privileges: grants, default privileges, policies and row-level security are set up on each target by hand, and deployments leave them alone. Test that promise as a DBA would:
- Create application roles, and grant them access the way the README recommends (`ALTER DEFAULT PRIVILEGES FOR ROLE <deploy role> …` plus grants on existing objects). Deploy several migrations, and check that the app roles really can read and write what each one creates.
- Make a hand-made policy and `ENABLE ROW LEVEL SECURITY` on a table, then deploy changes:
  - one that leaves the table alone;
  - one that adds a column;
  - one that changes the type of a column the policy uses, which the README says fails, with the policy named.
- A migration that drops and recreates a view or function: check what happens to its hand-made grants, against what the README says.
- Try to declare a grant, revoke, policy, row-level security or `SECURITY DEFINER` in the desired schema and in each script kind. Check the refusals and whether their messages say what to do instead.
- Ownership: objects owned by another role on a target, and a deploy role that's a member of the owner. Then `status`, `deploy`, `mark` and `rebuild`.
- `status` and drift after all of the above: none of the hand-made privileges should show as drift.
- External schemas: a PL/pgSQL function reading an `auth` schema that exists on one target and not on another. Deploy both, then call the function as an app role.

Changed since round 2:
- **Routine bodies with unqualified names:** when `managedSchema` isn't `public`, `draft`, `finalize` and `validate` warn about them, and the README has a section on it. Check the warning against what really fails for an app role.
- **Losing hand-made privileges:** `status`, `deploy` and `deploy-draft` warn when a migration will drop and recreate an object whose hand-made grants, revokes or policies default privileges won't restore, including a recreated function regaining PUBLIC's EXECUTE.
- **`FORCE ROW LEVEL SECURITY`** on a table must no longer silently filter a deployment's scripts.
- **Privilege statements inside routine bodies** (e.g. a trigger function with a dynamic-SQL override that runs GRANT or DISABLE ROW LEVEL SECURITY) are refused.
- **Privilege refusals** say what to do instead and where it's documented. `SET LOCAL ROLE`'s refusal gives a reason that applies.
- **Scripts that fire a trigger reading an external schema:** check that rehearsal works as the README now describes.
- **The README:**
  - warns that views bypass hand-made row-level security;
  - its grant recipe covers refreshing materialized views (`MAINTAIN`).
