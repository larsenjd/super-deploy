# 03: Tracer bullet: declare, rehearse and deploy an extension

**What to build:** A developer can write `create extension citext version '1.8';` and a table with a `citext` column in the desired schema, list `citext: ["1.8"]` in the config, and take it all the way through `draft`, the draft rehearsal, `finalize` and `deploy`. The target ends up holding citext 1.8 in the managed schema, owned by the deploy role, with no drift. (Spec: "Desired-schema rules", "Ordering and references", "The differ wrapper", "Deploy-time rules", "Rehearsals"; user stories 1–14, 21, 26–30, 39.)

The desired-schema rules:
- accept `CREATE EXTENSION` only for a supported extension the config lists, with a `VERSION` the config lists;
- accept `SCHEMA` only when it names the managed schema, and `IF NOT EXISTS` as a no-op;
- refuse `CASCADE` and `COMMENT ON EXTENSION`.

Ordering resolves an extension's types and functions from the generated source (ticket 01) at the pinned version, so an unqualified `citext` column or a `gen_salt()` default resolves. Operators and operator classes are ticket 04.

The differ wrapper adds `VERSION '<v>'` to pg-delta's `CREATE EXTENSION`, and the deploy-time rules accept that statement in schema changes. A rehearsal whose server can't install the pinned version fails with a typed error naming the extension, the version and what the server offers, and never falls back to another version.

**Blocked by:** 01, 02

**Status:** resolved

- [x] Integration test: the citext desired schema goes through `draft`, `finalize` and `deploy`.
  - The schema change contains `CREATE EXTENSION citext ... VERSION '1.8'`.
  - The target has citext 1.8 in the managed schema, owned by `deployer`.
  - `status` then reports no drift.
- [x] `CREATE EXTENSION` without `VERSION` is refused, naming the versions the config lists.
- [x] An unsupported extension (for example `earthdistance`) is refused, listing the supported ones.
- [x] A supported extension missing from the config is refused, saying to add it to `extensions`.
- [x] A `VERSION` the config doesn't list is refused, naming the listed versions.
- [x] `SCHEMA` naming another schema, `CASCADE` and `COMMENT ON EXTENSION` are refused. `SCHEMA` naming the managed schema and `IF NOT EXISTS` are accepted.

  These refusals (this and the three above) have rule ids in the rule catalogue, in the "unsupported" category, a README line each, and a row in the README-coverage test.
- [x] `validate` gives the same refusals as `draft`.
- [x] A reference to a type or function the extension doesn't provide at the pinned version is an unknown reference.
- [x] A rehearsal on a server lacking the pinned version fails with the new typed error. The test uses fault injection on the rehearsal adapter, the existing wrapper pattern.
- [x] The deploy-time rules accept `CREATE EXTENSION <supported> VERSION '<v>'` in a schema change, and still refuse one without `VERSION` or for an unsupported extension.
- [x] pg-delta's output for adding an extension is checked: whether it emits `COMMENT ON EXTENSION` or a `SCHEMA` clause. The result is recorded in the differ module's header or the pg-delta known-behaviours notes, and a pg-delta schema-change fixture with an extension passes as a schema change.
- [x] Existing tests that assert citext or pgcrypto are refused in the desired schema or deploy-time SQL are updated. Tests that need some extension refused use an unsupported one.

## Comments

pg-delta emits `CREATE EXTENSION "x" SCHEMA "<managed>"` plus a `COMMENT ON EXTENSION` per extension; the differ wrapper (differ/extension-versions.ts) adds VERSION and drops the comments. Known gap: the rehearsal version check runs only when a desired schema loads, so a deployment rehearsal replaying pending migrations on a server lacking the version fails with PostgreSQL's raw error rather than RehearsalExtensionVersionError (only possible with a non-embedded rehearsal server).
