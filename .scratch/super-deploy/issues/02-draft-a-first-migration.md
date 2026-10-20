# 02: Draft a first migration

**What to build:** In the example project, a developer writes a one-table desired schema and runs `super-deploy draft --name "Add customers"` (or calls `draft()` from the API). They get a draft named `add-customers` whose generated schema change creates the table. This is the first slice through every layer: config, adapters, SQL analysis, differ, CLI.

**Blocked by:** 01

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] `super-deploy.config.ts` with `defineConfig()` is found from the working directory or a parent and loaded with Node's built-in TypeScript support; invalid settings fail naming the setting.
- [ ] Rehearsal adapter interface plus an `embedded-postgres` PG18 implementation used by the example project; throwaway databases are always dropped; a server that isn't PostgreSQL 18 is refused.
- [ ] Deployment adapter interface plus the library's node-postgres adapters from a connection string or environment variable.
- [ ] The desired schema is loaded into a throwaway database and read back from the catalogs (ADR-0003); for this slice, a single file is enough.
- [ ] Differ interface wrapping `@supabase/pg-delta` pinned to exactly `1.0.0-alpha.59`, calling extract and plan directly, never its directory loader, never pg-topo. Prototype harness and scenarios: branch `prototype/pg-delta` (`9d619fe`), findings in `research/pg-delta-prototype.md`.
- [ ] SQL analysis skeleton on `libpg-query@18` with an allowlist that accepts `CREATE TABLE` in the desired schema and refuses everything else with file and line.
- [ ] Draft names: trimmed, lowercased, space runs collapsed to one hyphen, other invalid characters refused; kebab-case, at most 60 characters; editable until finalize.
- [ ] Direct CLI mode: `--help`, `<command> --help`, one-line `Error:` messages, exit codes 0, 1 and 2; usage errors run nothing.
- [ ] `draft()` is an exported function taking a loaded project and throwing typed errors.
- [ ] Tested at the API seam against real PG18, and at the CLI seam for help, usage errors and exit codes.
