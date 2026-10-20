# 19: Example and template content

Status: ready-for-agent
Type: task
Blocked by: 17, 18
Spec: ../spec.md

## What

Fill `packages/example` and `packages/template` with a realistic project (spec §11).

## Acceptance criteria

- [ ] Example: several migrations exercising renames in pre-migration scripts, backfills in post-migration scripts, a Recovery, seed data.
- [ ] Template: config with embedded-postgres adapter and `dev` target, `.gitattributes`, VS Code settings, README stating seed data must be synthetic or anonymised.
- [ ] Both precommits run Biome check, typecheck and `validate --strict`.
