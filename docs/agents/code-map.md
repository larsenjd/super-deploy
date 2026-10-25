# Code map

Where things live and where a change goes. Every source file opens with a header comment giving its job and the decisions behind it: read the header of a file before its body, and trust the header over this map.

## Packages

| Package | Path | What it is |
|---|---|---|
| `superdeploy` | `packages/super-deploy` | The library and its `super-deploy` CLI, published to npm as `superdeploy`. `pnpm build` (`scripts/build.ts`) compiles `src/` to `dist/` with plain `tsc`, then copies `packages/template` into `dist/template`. |
| `super-deploy-template` | `packages/template` | The project `init` copies (`src/store/template.ts`: `dist/template`, or this folder when running from source). `init` renames `project.gitignore` and `project.pnpm-workspace.yaml` to `.gitignore` and `pnpm-workspace.yaml` (`renamedOnInit`) and rewrites `superdeploy: workspace:*` to the library's exact version (`src/commands/init.ts`). Its README is the user documentation. |
| `super-deploy-example-shop` | `examples/shop` | A realistic history of five migrations and a Recovery, made with the real CLI; its README walks through it. Its `precommit` also runs `scripts/rehearse-history.ts`, which deploys the whole history to a throwaway database through the public API. |

The template and example devDepend on `superdeploy: workspace:*`; their `tsc` and `super-deploy` binary use the library's `dist/`. Finalized migrations are hashed and read-only, so the example's history changes through the CLI (`unfinalize`, `draft`, `finalize`), as a user's would.

## Entry points (`packages/super-deploy/src`)

- `index.ts`: the public API, package export `superdeploy`. Each command is an exported function `(project, options)`: flags as options, questions as callbacks, typed errors. Export every new command, its option and result types, and every new error from here.
- `adapters/embedded-postgres.ts`: the second package export, `superdeploy/embedded-postgres`.
- `cli.ts`: the `super-deploy` bin (`dist/cli.js`); the CLI itself is `cli/`.

## Directories

| Path | Job and key exports |
|---|---|
| `commands/` | One file per command: the API function behind it. `check-rules.ts` gathers a migration's or draft's files from disk for the deploy-time rules (`analyseReplayUnit`, `refuseRuleViolations`). `rehearse.ts` also holds `rehearseCurrentDraft`, the front half shared with `finalize`. |
| `cli/` | `definitions.ts`: the `commands` list that drives direct mode, help and the menu (`CommandDefinition`, option kinds, `acknowledge`, `needsProject`). `parse.ts` argv, `main.ts` the shell, `menu.ts`, `prompts.ts` (clack), `run.ts` (one command, exit codes 0/1/2), `process.ts` (signals, exit codes 129–149). |
| `errors.ts` | The base `SuperDeployError`, `ErrorCode` (the union of stable codes, computed from the error classes `index.ts` exports) and `listed`. Each error class lives in the module that throws it, next to its payload types; errors several modules throw live with their concept (`NoDraftError` in `store/draft.ts`, the Recovery errors in `commands/recovery.ts`). |
| `config/config.ts` | `defineConfig`, the config types, `resolveConfig` (defaults applied, unknown keys refused). |
| `project.ts` | `loadProject` → `Project` (root, config, paths, signal, `close()`); `findConfig`. |
| `questions.ts` | The `Question` union and callback types (`Confirm`, `AskOverrideReason`), `acknowledgeOverwrite`. |
| `end-of-input.ts` | `askUntilEndOfInput`: every clack prompt (the guard's YES question, `cli/prompts.ts`) is asked through it, so Ctrl+D on an empty answer cancels like Escape. |
| `interruption.ts` | How a command honours `project.signal`: `cleanupOnAbort`, `throwIfInterrupted`, `settleCleanups`. |
| `adapters/` | `types.ts` (`Session`, `DeploymentAdapter`, `RehearsalAdapter`, `ThrowawayDatabase`), `node-postgres.ts` (`postgresTarget`, `postgresRehearsal`), `embedded-postgres.ts` (built on `embedded-server.ts`: initdb and `pg_ctl` start/stop, and `server-lease.ts`: the client files and lock that let commands share one server), `ports.ts` (`freePort`, `portInUse`; `init` writes a free port for `dev`). |
| `sql-analysis/` | Database-free rules and ordering; barrel `index.ts`. `parse.ts` (`parseSqlFile`, the one splitter), `rules.ts` (`checkRules` per file kind), `desired-schema-rules.ts`, `deploy-time.ts` (`analyseMigration`), `destructive.ts`, `overrides.ts` (the override marker, `markerPrefix`, `isOverridable`), `rule-catalogue.ts` (every rule id with its category), `ordering.ts` and `references.ts` (`statementFacts`), `denylist.ts`, `recreated.ts` (`recreatedObjects`: what deploy-time SQL drops and creates again), `privileges.ts` (`privilegeRefusal`: grants, roles, ownership, row-level security and `SECURITY DEFINER`, refused by both rule sets), `schemas.ts`, `routine-bodies.ts`, `adoption.ts`, `adoption-folding.ts` and `adoption-overrides.ts`, `syntax-tree.ts` (`walkNodes` and friends), `statement-names.ts` (also `quoteIdentifier`). `pg-catalog-names.ts` is generated by `scripts/generate-pg-catalog-names.ts`. |
| `differ/` | The differ seam (ADR-0003): `types.ts` (`Differ`), `pg-delta.ts`, and `index.ts`, the one place the differ is chosen. What pg-delta gets wrong and how the rest of the code allows for it: `.scratch/super-deploy/research/pg-delta-prototype.md` §8 "Known behaviours". |
| `rehearsal/` | Throwaway databases and every rehearsal. `throwaway.ts` (`withThrowawayDatabase`, `pinnedSettings`, `loadDesiredSchema`, `ensureManagedSchema`), `replay.ts` (`replay`, `runUnit`, `readReplayUnit`, `readMigrationUnits`), `rehearse-draft.ts`, `rehearse-deployment.ts`, `rehearse-recovery.ts`, `replica.ts` (`withReplica`, `replicaUnits`), `same-structure.ts` (`requireSameStructure`, `structuralDifferences`), `schema-change-check.ts` (`checkSchemaChange`: `draft` runs its own schema change and names what falls short; `mismatchCauses` for the draft rehearsal's message), `order-independence.ts`, `seed-data.ts` (`readSeededUnit`, `seededUnits`, `seededFiles`), `script-coverage.ts`. |
| `deploy/` | The deployment engine and target state. `engine.ts` (`withLockedTarget`, `inDeployTransaction`, `applyMigrations`, `commitRecorded`), `history.ts` (the history schema: its layout is in the header), `attempts.ts` (attempt log, `settleAttempts`), `lock.ts`, `preflight.ts`, `recreated-privileges.ts` (the pre-flight's warning about hand-made privileges and policies a recreated object loses), `ownership.ts` (the deploy role owns the managed schema: pre-flight, `mark`, adoption), `target.ts`, `mark.ts` (`markNextPending`), `wipe.ts` (`rebuild`'s wipe), `pending.ts`, `interruptible-session.ts`, `session-ended.ts` (a target session that ends or times out under a command: `TargetSessionEndedError`, `TargetTimeoutError`), `rollback.ts` (`TargetRollback`, `commandNoun`, `rolledBackSentence`: what a rolled-back command left the target at, one sentence for every report of it). |
| `guard/` | Guarded commands (`disposable`, `deploy-draft`, `rebuild`, `mark`): `runGuarded` in `guard.ts`, the YES question in `prompt.ts`. |
| `verification/` | Our own pg_catalog comparison, independent of the differ: `catalog.ts` (`catalogFacts`, `catalogDifferences`), `drift.ts` (`driftBetween`, `driftedObjects`, `driftLabel`: the words a difference's side is shown with). |
| `store/` | The project on disk. `layout.ts` (directory layout, `projectPaths`, `projectRelative`), `migrations.ts` (migration and Recovery folders, file names such as `snapshotDiffFileName`, `index.json`, read-only state), `integrity.ts` (`checkMigrations`, `verifiedMigrations`), `hashing.ts`, `snapshots.ts` (`readSnapshot`, `readSnapshots`: the one place a migration's snapshot is read, rebuilt from the `desired-schema.diff` files one at a time or a history's in one pass; `snapshotDiff`, the diff finalize writes, checked to rebuild the desired schema), `draft.ts`, `hand-edit.ts` (a hand-edited schema change: detected, reported in `HAND-EDITED.md`, restored by unfinalize) with `unified-diff.ts` (also `filesDiff` and `applyFilesDiff`, the git-style diff of a set of files a snapshot is stored as, ADR-0008), `draft-name.ts`, `desired-schema.ts`, `template.ts`. |
| `version.ts` | `toolVersion`, and the parser's name and version for metadata. |

Tests are mapped in `docs/agents/testing.md`.

## Where a change goes

- **Command**: the API function in `commands/<name>.ts`, exported from `index.ts`, plus a `CommandDefinition` appended to `commands` in `cli/definitions.ts`; help, parsing and the menu follow from it. A command without a project sets `needsProject: false`.
- **Error**: a `SuperDeployError` subclass in the module that throws it, declaring its own `readonly code = "<kebab-case>"`, exported from `index.ts`; `ErrorCode` picks the code up from the export, and an unexported error fails to compile. The message is one line, with project-relative paths (`projectRelative`).
- **Question**: a member of the `Question` union in `questions.ts`, asked through the command's callback option; `cli/definitions.ts` answers it at the terminal.
- **Rule id**: an entry in `sql-analysis/rule-catalogue.ts`. Only `risk` rules are overridable.
- **Allowed desired-schema statement form**: the allowlist in `desired-schema-rules.ts`, and an extractor in `references.ts` (`statementFacts`), which ordering needs for every form.
- **Deploy-time file**: `deployTimeFileNames` and `deployTimeFileKinds` in `store/migrations.ts`; finalize, hashing, replay and the rules pick it up from there.
- **Reading or writing a snapshot**: only through `store/snapshots.ts` (`readSnapshot`, `readSnapshots`, `snapshotDiff`), which rebuilds snapshot N from the `desired-schema.diff` of migrations 1 to N; the diff format, writer and strict applier are `store/unified-diff.ts` (ADR-0008).
- **Anything that changes a target**: the body runs under `withLockedTarget`, which brings the attempt, the lock, settling and interruption; a guarded command goes through `runGuarded`. Send statements on the session it hands you.
- **Comparing structure**: extend `verification/catalog.ts`; rehearsals, drift and `mark` all share it.
