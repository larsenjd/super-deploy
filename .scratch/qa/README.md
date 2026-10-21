# Exploratory QA

How to run a round of agent QA on super-deploy: several testers use the built CLI the way a new user would, each in one area, and write every problem they find as an issue in `issues/`. Nobody fixes anything during a round. The issues then go to `/triage`.

Round 1 (2026-10-20, issues 01–68) is triaged and closed out. Round 2 numbers from 101.

## Running a round (for the orchestrator)

1. Check `main` builds: `pnpm build` at the repo root. Testers use `packages/super-deploy/dist/cli.js`.
2. Check the shared server is up: `node ~/.local/share/super-deploy-qa/sql.mjs postgres "select 1"`. If it isn't, start it with the line in `~/.local/share/super-deploy-qa/README.md`. Never stop it during a round.
3. Pick the round number `R` and give each area its issue range (below).
4. Start one background subagent per area, all at once. Each prompt is the **Tester brief** below with `<R>`, `<area>` and `<range>` filled in, followed by that area's section from **Areas**.
5. As each finishes, relay its report to the user: issue count, the high-severity ones, and anything it couldn't test. Don't verify the findings yourself; `/triage` does.
6. When all have finished, list the issues by severity and suggest `/triage .scratch/qa/issues — round <R> (issues <first>–<last>)`.

Round 2 ranges: `newproj` 101–119, `adopt` 120–139, `fail` 140–159, `disp` 160–179, `privs` 180–199.

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

Each section is appended to the tester brief. "Changed since round 1" lists what to press hardest, because it hasn't been tested by anyone outside its own tests yet.

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

Changed since round 1:
- **`dev`:** it now has its own embedded server at a fixed port, and deploys as a role that isn't a superuser. Connect to it as the README's "Connecting to dev" says.
- **Rehearsals** use a separate server.
- **Two commands at once** in one project now share the servers under a lease.
- **Narrowing a column** (`text` → `varchar(5)`, `numeric(6,2)` → `numeric(4,1)`) has its own warning at `draft` and `finalize`.
- **Unknown files in the draft folder** (e.g. `post-migrate.sql`) are warned about.
- **Committing while a draft exists:** the pre-commit hook now allows it (`validate --allow-draft`), but CI-style `validate --strict` doesn't.
- **`unfinalize`** warns about deployed migrations.
- **Rehearsal mismatch messages** now depend on what changed.
- **Exit codes:** check `status` in every state (up to date, pending, drift, would refuse), against `--help`.

### adopt: adopting an existing database

Build realistic existing databases by hand with SQL, then bring them under management with `init --adopt`:
- a named managed schema, and one using `public`;
- foreign keys, indexes, views, functions and triggers;
- domain-typed columns, function defaults and generated columns;
- functions that need an override marker (dynamic SQL, `pg_notify`); adopt in a terminal and answer the override-reason questions;
- objects super-deploy refuses, to see the refusal;
- a typo in the managed schema name.

After adoption: `status`, `validate`, then draft, finalize and deploy a change to the adopted target.

Changed since round 1:
- **Privileges are outside super-deploy:**
  - adoption leaves the target's grants, policies and row-level security on the target and counts them;
  - it refuses `SECURITY DEFINER` routines;
  - it refuses a target where another role owns the managed schema or anything in it, listing each object with its `ALTER … OWNER TO` fix.
- **A missing `CREATE` privilege on the database** is now refused up front.

### fail: things going wrong

Set up a project with a few migrations deployed to a shared-server target, then break things:
- **Drift:** change the target by hand.
- **Locks:** hold a lock from another session while deploying, and run two deploys at once.
- **Failing scripts:** a script that fails on real data, fixed with a Recovery.
- **Interruptions:** Ctrl+C and SIGTERM during `deploy`, `finalize` and a rehearsal; SIGKILL mid-deploy, then `status` and the next `deploy`.
- **Tampering:** edit a finalized migration.
- **Bad input:** a broken config file, bad and unset connection strings, a target whose server is down (use a port nothing listens on), an unreachable host, SQL errors.
- **Output:** exit codes, stdout vs stderr, `--debug`, and piping into `head`.

Changed since round 1:
- **Interrupted deploys** now exit with the interruption's code.
- **Lock refusals** name the holder's session and how to end it, and a vanished client's session is detected.
- **Connection errors** got better messages.
- **`sslmode`** follows libpq's meaning (try `?sslmode=require` against the shared server, which has no TLS).
- **Drift output** labels its sides in words.
- **Failed scripts** report the statement and line.
- **A failed deploy** says it rolled back and points to Recovery.

### disp: disposable targets and the guarded commands

Work out from `--help` and the README what a disposable target is. Exercise `disposable`, `deploy-draft` (with and without seed data), `rebuild --to N` and `mark` on shared-server targets, both disposable and not. Run every guarded command without a terminal, on a non-disposable target, with answers other than YES, with Ctrl+C and Ctrl+D at the prompt, and with the target changed while the prompt waits.

Changed since round 1:
- **The `disposable` confirmation** shows the managed schema's tables and estimated rows.
- **The `rebuild` confirmation** lists:
  - objects in the managed schema that no migration created;
  - objects in *other* schemas its wipe will drop, such as a view, a foreign key, or a column of a managed row type with its data.
- **`rebuild` refuses before YES** when the managed schema holds something the deploy role can't drop, such as a superuser's extension.
- **`rebuild` leaves the managed schema's grants and default privileges alone.**
- **`mark` refuses** objects owned by another role.
- **`deploy-draft` warns** about a stale draft.

### privs: privileges set up outside super-deploy (new in round 2)

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
