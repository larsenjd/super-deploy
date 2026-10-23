# 241: SIGTERM to `pnpm exec super-deploy deploy` in a terminal returns the prompt with 143, then the deployment commits

**Status:** needs-triage
**Category:** docs
**Severity:** medium
**Area:** fail
**Round:** 3

## What I did
Project with a pending migration whose post-migration script takes ~15 s, target `qa` on the shared server. pnpm is installed through corepack (`which pnpm` → `.../corepack/dist/pnpm.js`).

In a pseudo-terminal running an interactive `zsh`, I typed:

```sh
pnpm exec super-deploy deploy --target qa; echo shell-saw-exit=$?
```

Once the deployment was running on `qa` (its post-migration statement visible in `pg_stat_activity`), from another shell I sent SIGTERM to the `pnpm exec` process the shell started (`kill -TERM <pid of "node .../bin/pnpm exec super-deploy deploy --target qa">`), the way a user would `kill` a command they see in `ps`.

I did the same without a terminal (`pnpm exec ... &`, then SIGTERM to the pnpm pid).

## Expected
Either the deployment stops and rolls back (it was interrupted with SIGTERM), or the README warns that this happens in a terminal too, not only "in CI or under a supervisor".

## Actual
In the terminal:

```
zsh: terminated  pnpm exec super-deploy deploy --target qa
shell-saw-exit=143
PROMPT> Deployed 1 migration to qa: 00007-add-labels
```

The prompt comes back with 143, then about 20 s later `Deployed 1 migration` appears on the prompt line. `status --target qa` shows `#17 deploy succeeded migration 7`. Without a terminal, the same: the job ends with 143 and `status` shows the attempt succeeded.

## Notes
The README ("Interrupting a command", "In CI or under a supervisor") documents the non-terminal case, and says to run the binary directly or signal the whole process group. It doesn't mention that the same happens in a terminal when someone `kill`s the pnpm process (e.g. from another window), and the rest of the README tells users to run everything as `pnpm exec super-deploy ...`. A 143 from a deploy is easy to read as "it was stopped". At least the README should say this applies everywhere pnpm comes from corepack, and that `kill -TERM -<pgid>` (or `kill %1` from the same shell) is the way to stop it.
