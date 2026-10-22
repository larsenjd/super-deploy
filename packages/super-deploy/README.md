# superdeploy

Immutable, all-or-nothing PostgreSQL 18 migrations generated from a desired
schema. You describe the schema you want as `CREATE` statements; super-deploy
generates each migration from it, rehearses it on a throwaway database, and
deploys every pending migration to a target in one transaction.

The package is `superdeploy`; its command is `super-deploy`. Requires Node 24
and pnpm. Projects start with private embedded PostgreSQL 18 servers, so no
database is needed to try it.

## Creating a project

```sh
mkdir my-schema && cd my-schema
pnpm dlx superdeploy init
git init
pnpm install
```

Then write `CREATE` statements under `data-model/desired-schema/` and run:

```sh
pnpm exec super-deploy draft --name "add customers"
pnpm exec super-deploy finalize
pnpm exec super-deploy deploy --target dev
```

`pnpm exec super-deploy` with no arguments opens an interactive menu.

## Documentation

Each project's `README.md` is the full guide: what the desired schema
supports, configuration, real targets, adopting an existing database,
permissions, drift and recovery. The same guide is
[in the repository](https://github.com/larsenjd/super-deploy/blob/main/packages/template/README.md).

## Licence

MIT
