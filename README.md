<img src="assets/icon.svg" width="64" height="64" alt="">

# super-deploy

Created in [T3 Code](https://t3.codes).

## Repository layout

A pnpm workspace (Node 24, ESM only, strict TypeScript built with plain `tsc`):

- `packages/super-deploy`: the library and the `super-deploy` CLI. Its build bundles the template into `dist/template`.
- `packages/template`: the project that `super-deploy init` copies.
- `examples/shop`: an example project.

Open `super-deploy.code-workspace` in VS Code for per-package settings.

## Development

```
pnpm install
pnpm build
pnpm lint              # Biome check, every package
pnpm typecheck
pnpm test              # unit and integration tests
pnpm test:unit         # database-free tests only
pnpm test:integration  # tests against real PostgreSQL 18
```

Every cross-package script runs as `pnpm -r <script>`. The pre-commit hook runs `pnpm precommit`.
