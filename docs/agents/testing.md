# Testing

What to test, and at which of the three seams, is decided in the spec's "Testing Decisions" (`.scratch/super-deploy/spec.md`). This file is how to write a test at each seam with the helpers in `packages/super-deploy/test/support/`. Each helper's JSDoc has the details.

## Running tests

From `packages/super-deploy`:

- While working, run the file at hand: `pnpm exec vitest run test/integration/deploy.test.ts`, plus `-t "<test name>"` for one test.
- Vitest projects (`vitest.config.ts`, which also sets the timeouts): `unit` is `test/unit/**`, database-free (`pnpm test:unit`); `integration` is `test/integration/**`, real PostgreSQL 18 (`pnpm test:integration`). Its global setup (`test/support/build-once.ts`) builds `dist/` once per run for the CLI seam.
- The full suite, `pnpm test`, runs once at the end of the work.
- The pre-commit hook runs `pnpm precommit` at the root: Biome, then each package's `precommit`. The library's is Biome, `tsc` and the unit tests. The template's and the example's are Biome, `tsc` and `super-deploy validate --strict`; the example's then runs `scripts/rehearse-history.ts`, which starts embedded PostgreSQL. These use `dist/`, so run `pnpm build` after changing `src/` and before committing.

## Every test

- Import the library by package name, `super-deploy` and `super-deploy/embedded-postgres`, so a test reaches only the public API. Vitest and tsconfig `paths` alias both to `src/`, so the API seam needs no build. SQL-analysis tests may also import `src/sql-analysis/index.ts`.
- Each PostgreSQL server a test starts has a free port and a unique temp data dir, and the test stops it: other worktrees run their suites on the same machine. `startTestServer` does all three.
- Tests within a file run one at a time: `createTestProject` cleans up through the global `onTestFinished`, which can't tell concurrent tests apart, so under `test.concurrent` one test deletes another's project.

## Seam 1: programmatic API (`test/integration/*.test.ts`)

```ts
import { draft, loadProject } from "super-deploy";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject, embeddedConfig } from "../support/project.ts";

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { await server?.stop(); });

test("draft writes the schema change", async () => {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { "data-model/desired-schema/customers.sql": "create table ..." },
  });
  const project = await loadProject({ cwd: dir.root });
  await draft(project, { name: "Add customers" });
  expect(await dir.read("data-model/draft/schema-change.sql")).toContain("CREATE TABLE");
});
```

- `postgres.ts`: `startTestServer()`, one embedded PostgreSQL 18 per file. Projects attach to it through its data dir, so `project.close()` leaves it running. Observe it with `server.query(sql, values?, database?)`, `server.databases()` (e.g. that throwaway databases were dropped) and `server.createDatabase(sql?)`.
- `project.ts`: `createTestProject({ config, files })`, a temp project deleted when the test finishes; `embeddedConfig(server, settings?)` splices `settings` into `defineConfig({...})`.
- `deploy.ts`, for tests that touch a target: `deployProject(server, desiredSchemaFiles, options)` gives each test a `dev` target in a database of its own, so tests never share target state. The options splice code into the config: `adapter`, `rehearsal`, `target` (e.g. `lockTimeout: "200ms",`), `otherTargets`, `settings`, `preamble`. Also `finalizeMigration(project, name)`, `testSession(server, database)` (a session the test controls, e.g. to hold a lock), `targetDatabaseName()`, `roleName(prefix)` (roles are server-wide) and `asDeployerPreamble(database, role)` (an `asDeployer` adapter logging in as another role).
- `round-trip.ts`: `describeRoundTrips(scenarios)` drafts, finalizes and deploys a → b → c → a for each scenario in `test/fixtures/round-trips.ts`, split across `round-trips-{1,2,3}.test.ts`.
- Answer questions through the command's callback option (`confirm`, `overrideReason`) or its flag option (`acknowledgeDestructive`, `acknowledgeOverwrite`).
- Guarded commands (`disposable`, `deploy-draft`, `rebuild`, `mark`) are terminal-only by design. At this seam test only their refusal (`vi.stubEnv("CI", "true")` gives `TerminalRequiredError`); their behaviour goes through the pseudo-terminal.
- Roles: rehearsals create none, and no file super-deploy deploys may name one. Roles are server-wide, so a test that creates roles on the target (by hand, as an administrator would) names them with `roleName`.
- Embedded targets log in as the superuser `super_deploy`, so `deploy` and `status` always carry the superuser warning (stderr in the CLI).

## Seam 2: CLI process (`test/integration/cli-*.test.ts`)

Only what exists at the process boundary: flags and usage errors, exit codes, stdout versus stderr, signals and closed output, guarded commands refusing. Everything else belongs to the API seam.

- `cli.ts`: `runCli(args, { cwd, env? })` returns `{ exitCode, stdout, stderr }`; it spawns `node dist/cli.js` with `CI=1` and no terminal. For signals, `spawnCli(args, { cwd, env, detached })`: `signal(sig)` reaches the CLI only, `signalGroup(sig)` its whole process group like Ctrl+C in a terminal (needs `detached`). `waitForFile(path)` waits for a marker file.
- A temp project's `node_modules/super-deploy` is a junction to the package, so its config's imports resolve to `dist/` under Node's own type stripping.
- `project.ts`: `stallingConfig(dataDirExpression)` is a rehearsal adapter that stalls on demand (`TEST_STALL=query` or `drop`, after writing the file named by `TEST_MARKER`), for signalling a command mid-flight.

### Pseudo-terminal (`terminal.ts`)

`spawnTerminal(args, { cwd, env? })` runs `dist/cli.js` in a pseudo-terminal (`@lydell/node-pty`) with `CI` removed: the menu, questions, and guarded commands. `type(keys.enter)` (also `escape`, `down`, `up`, `ctrlC`, `ctrlD`, or any text); `await waitFor(textOrRegex)` consumes the screen up to the match, so wait for each screen before typing into it; `await exited` gives the exit code. `screen` is the output without escape sequences; `output` keeps them, for checks such as `showCursor`. Wrap these tests in `describe.skipIf(process.platform === "win32")`: ConPTY is unverified.

Select menu items with `await chooseMenuItem(label)`: it presses Down until the screen shows that item selected, then Enter, so adding a command never shifts a test. Count arrow presses only when the cursor position is what the test checks.

## Seam 3: SQL analysis (`test/unit/**`)

Pure functions, no database, run by the pre-commit hook: `checkRules({ path, text }, kind, context)`, `analyseMigration(files, options)`, `analyseDesiredSchema`, `orderDesiredSchema(files)` and the rest of `src/sql-analysis/index.ts`. Fixture suites: `test/fixtures/ordering.ts` (an accepted fixture's `before` pairs must hold in both load orders) and `test/unit/sql-analysis/fixtures/pg-delta-schema-changes/` (every pg-delta schema change must pass as `schema-change`).

## Fault injection

Wrap the real adapter in the test project's config. With `deployConfig`, pass an expression wrapping `real` (the `dev` adapter) as `adapter`, or wrapping `postgres.rehearsal` as `rehearsal`, with any helper code in `preamble`. The wrapper spreads the real session and overrides `execute`, `query` or `serverVersion`. Examples: `pausingAdapter` in `deploy.test.ts`; `losingAdapter` and `stallingAdapter` in `failure-handling.test.ts`.

- **Switching a fault on**: at the API seam the config runs in the test's own process, so the wrapper reads a `globalThis.<flag>` the test sets. At the CLI and pseudo-terminal seams it runs in the child, so it reads `TEST_*` environment variables and reports progress through a marker file (`TEST_MARKER`, `waitForFile`).
- **Finding the deploy transaction**: its statements are listed in `src/deploy/engine.ts`'s header. Key on the first batch containing `lock_timeout` and not `READ ONLY`, as the existing wrappers do.
- **Holding a lock against a deployment**: take ACCESS SHARE through `testSession`. ACCESS EXCLUSIVE also blocks the drift check's catalog read (`pg_get_indexdef` waits for the table lock), so the deployment fails there instead of at its own statement.
- **Release in `finally`** every lock and pause the test holds: one left held keeps the test waiting until its timeout.
