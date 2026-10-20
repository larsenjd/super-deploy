# PostgreSQL schema

This project manages a PostgreSQL 18 schema with super-deploy: you edit the
desired schema, and super-deploy generates immutable, all-or-nothing
migrations from it.

## Getting started

```sh
pnpm install
```

Nothing else is needed: `super-deploy.config.ts` runs a private PostgreSQL 18
server in `.super-deploy/postgres` (gitignored). It provides the throwaway
databases that rehearsals use and the local `dev` target, and starts on a free
port whenever a command needs it.

1. Describe the schema you want as `CREATE` statements in `.sql` files under
   `data-model/desired-schema/` (any file names and folders).
2. `pnpm exec super-deploy draft --name "add customers"` generates the draft's
   schema change in `data-model/draft/`.
3. `pnpm exec super-deploy finalize` rehearses the draft and freezes it as the
   next numbered migration in `data-model/migrations/`.
4. `pnpm exec super-deploy deploy --target dev` applies every pending
   migration to the target in one transaction.

Run `pnpm exec super-deploy` with no arguments for an interactive menu, or
`pnpm exec super-deploy --help` for every command. Add real targets (QA,
production) to `super-deploy.config.ts`; keep credentials out of it, for
example by reading a connection string from an environment variable.

## Adopting an existing database

To bring a database that already exists under management, add it as a target
in `super-deploy.config.ts` (before any draft or migration exists), then run
`pnpm exec super-deploy init --adopt <target>`. Its managed schema becomes the
desired schema and migration `00001-adopt`, which is recorded on that target
as already deployed. If the database holds anything super-deploy doesn't
support, nothing is written and every such object is listed.

## Files

- `data-model/migrations/`: finalized migrations. Never edit them: they are
  read-only, and their hashes are checked by `super-deploy validate`.
- `data-model/draft/schema-change.sql`: generated; run `draft` again instead
  of editing it.
- `pnpm precommit` runs Biome, the type checker and
  `super-deploy validate --strict`. Run it before every commit, for example
  from a Git hook.

## Seed data

Seed data goes in `data-model/draft/seed-data.sql`: `INSERT` statements with
column lists that reproduce a target's problem data. The draft's rehearsals
load it just before the pre-migration script, so they prove the scripts
handle it; it is never loaded once the migration is finalized.

Seed data must be synthetic or anonymised. It is committed to git with its
migration and kept forever as an audit record, so never copy production data
into it.
