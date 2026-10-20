# 01: Repo scaffold

**What to build:** A pnpm workspace that every later ticket builds in: the library-and-CLI package, the example project and the template, all on Node 24, ESM-only strict TypeScript built with plain `tsc`, with Biome, Vitest, Husky and a CI matrix that goes green on Ubuntu, macOS and Windows.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] Every cross-package script (`format`, `lint`, `typecheck`, `test`, `precommit`) runs as `pnpm -r <script>`; the root only orchestrates.
- [ ] Repo scripts are TypeScript run by Node; no bash or PowerShell.
- [ ] Root Biome config excludes the packages; each package owns its own Biome config.
- [ ] Husky runs only `pnpm precommit`; the library's precommit runs Biome check, typecheck and unit tests.
- [ ] VS Code multi-root workspace with per-folder settings: recommended extensions (Biome, Postgres Language Server), editor format-on-save off, run-on-save calling the nearest package's `format:file`.
- [ ] The library build bundles the template package into its output.
- [ ] GitHub Actions runs lint, typecheck and tests on Ubuntu, macOS and Windows with Node 24, green on a placeholder test.
