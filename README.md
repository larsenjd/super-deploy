# super-deploy

Immutable, all-or-nothing PostgreSQL 18 migrations generated from a desired schema. To use it, see the [package README](packages/super-deploy/README.md): `pnpm dlx super-deploy init` creates a project.

## Repository layout

A pnpm workspace (Node 24, ESM only, strict TypeScript built with plain `tsc`):

- `packages/super-deploy`: the library and the `super-deploy` CLI. Its build bundles the template into `dist/template`.
- `packages/template`: the project that `super-deploy init` copies.
- `examples/shop`: an example project with a realistic migration history; its README walks through it.

Open `super-deploy.code-workspace` in VS Code for per-package settings.

## Development

```
pnpm install           # also installs the Git hooks and builds dist/
pnpm build             # rebuild dist/ after changing the library
pnpm lint              # Biome check, every package
pnpm typecheck
pnpm test              # unit and integration tests
pnpm test:unit         # database-free tests only
pnpm test:integration  # tests against real PostgreSQL 18
```

Every cross-package script runs as `pnpm -r <script>`. The pre-commit hook runs `pnpm precommit`.

## Releasing

1. Set the new version in `packages/super-deploy/package.json`. `init` writes it as the exact version new projects depend on, and finalize records it in each migration's metadata.
2. Run the full suite (`pnpm test`); `test/integration/package.test.ts` checks the tarball keeps every template file.
3. From `packages/super-deploy`, `pnpm publish`. Its `prepack` script rebuilds `dist/` first.

A published version can be unpublished only within 72 hours, and its number can never be reused. Once a version is published, every change to the history schema's columns raises `historyLayoutVersion` (`deploy/history.ts`) and ships an upgrade step for targets on the older layout.
