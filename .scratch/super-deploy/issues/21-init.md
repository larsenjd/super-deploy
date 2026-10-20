# 21: Init

**What to build:** A developer runs `init` in an empty folder and gets a working project with a local embedded PostgreSQL providing rehearsal databases and a `dev` target.

**Blocked by:** 04

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] The template contains the config with the `embedded-postgres` adapter and `dev` target, `.gitattributes` forcing LF for SQL and JSON, editor settings marking finalized migrations and generated schema changes read-only, and a README stating seed data must be synthetic or anonymised.
- [ ] `init` copies the template bundled in the library package; no network fetch.
- [ ] The template's precommit runs Biome check, typecheck and `validate --strict`.
- [ ] A freshly initialised project can `draft`, `finalize` and `deploy --target dev` with no other setup.
