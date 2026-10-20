# 02: Workspace scaffold

Status: ready-for-agent
Type: task
Spec: ../spec.md

## What

Set up the repo per spec §11: pnpm workspace with `packages/super-deploy`, `packages/example`, `packages/template`; TypeScript (Node ≥ 24, ESM, strict, plain `tsc`); Biome; Vitest; Husky; VS Code multi-root workspace; GitHub Actions CI.

## Acceptance criteria

- [ ] Every cross-package script (`format`, `lint`, `typecheck`, `test`, `precommit`) runs as `pnpm -r <script>`; root only orchestrates. Repo scripts are TypeScript run by Node, no shell scripts.
- [ ] Root Biome config excludes `packages/`; each package owns its `biome.json`.
- [ ] Husky runs only `pnpm precommit`. Library precommit: Biome check, typecheck, unit tests.
- [ ] `super-deploy.code-workspace` with per-folder `.vscode/` (recommended extensions; format-on-save off; run-on-save calling `pnpm run format:file`).
- [ ] CI matrix: Ubuntu, macOS, Windows × Node 24, running lint, typecheck, tests.
- [ ] Library build copies `packages/template` into the package output.
