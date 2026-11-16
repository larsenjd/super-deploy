# Supported extensions

**Status:** resolved

Decision and rejected alternatives: ADR-0009. Terms: **Supported extension**, **Drift** and **Deploy role** in `GLOSSARY.md`. Facts behind the decisions (installable versions, Aurora 18.4 and embedded-postgres per platform, ownership): `.scratch/extensions/research/supported-extensions.md`. What V1 still leaves out: REFINEMENTS "Extensions".

## Problem Statement

A developer whose schema needs a common PostgreSQL extension can't use super-deploy. Examples are case-insensitive emails with `citext`, hashing with `pgcrypto`, fuzzy search indexes with `pg_trgm` and `gin_trgm_ops`, exclusion constraints with `btree_gist`, and hierarchical paths with `ltree`. Every `CREATE EXTENSION` other than `plpgsql` is refused in the desired schema, in deploy-time SQL and in adoption. Teams either give up the extension or install it on each target by hand. A hand-installed extension is then drift that blocks every deployment. Its types can't appear in the desired schema at all, because rehearsals don't have them.

Even where a team manages extensions outside super-deploy, nothing ensures each target has the same extension version as the rehearsal. The same `CREATE EXTENSION citext` installs 1.8 on one server and may install 1.6 on Aurora. Nothing notices.

## Solution

The desired schema may install any of 17 supported extensions into the managed schema, at a version the developer states and the project's config allows:

```sql
create extension citext version '1.8';
```

```ts
export default defineConfig({
  extensions: { citext: ["1.8"], pgcrypto: ["1.4"] },
})
```

super-deploy then treats the extension like the rest of the desired schema:
- **`draft`** generates a schema change that creates, updates or drops it, always at the pinned version.
- **Rehearsals** install exactly that version, or fail.
- **Pre-flight** refuses, before any change, a target that can't install it or whose deploy role lacks `CREATE` on the database.
- **Drift** compares extensions and their versions across the target's whole database. Any extension the target's recorded migrations didn't create is drift, wherever it lives, except `plpgsql`.

The supported extensions are `btree_gin`, `btree_gist`, `citext`, `cube`, `dict_int`, `fuzzystrmatch`, `hstore`, `intarray`, `isn`, `ltree`, `pg_trgm`, `pgcrypto`, `tablefunc`, `tsm_system_rows`, `tsm_system_time`, `unaccent` and `uuid-ossp`. They are the extensions shipped with PostgreSQL that pass four tests: the deploy role can install them without being a superuser (they're trusted), Aurora PostgreSQL 18.4 offers them, they load on every embedded-postgres platform, and they stay inside the deploy transaction.

## User Stories

### Declaring an extension

1. As a developer, I want to write `create extension citext version '1.8';` in the desired schema, so that my tables can use the `citext` type.
2. As a developer, I want to use any of the 17 supported extensions, so that common needs (case-insensitive text, hashing, trigram search, GiST over scalars, hierarchies, key/value columns, UUID generation) are covered without hand work on targets.
3. As a developer, I want `CREATE EXTENSION` without `VERSION` refused with a message that names the versions my config allows, so that every extension is installed at a version I chose on purpose.
4. As a developer, I want an extension that isn't supported refused with a message listing the supported extensions, so that I know immediately what is possible.
5. As a developer, I want a supported extension my config doesn't list refused with a message saying to add it to the config's `extensions`, so that a project only uses extensions its team agreed on.
6. As a developer, I want a `VERSION` my config doesn't list for that extension refused with a message naming the listed versions, so that a typo or an unagreed upgrade is caught at `draft`.
7. As a developer, I want `SCHEMA` accepted when it names the managed schema and refused when it names any other schema, so that every extension lives where super-deploy manages it.
8. As a developer, I want `CASCADE` refused, so that no extension is installed that the desired schema doesn't name.
9. As a developer, I want `IF NOT EXISTS` accepted and to change nothing, as it already does for other statements, so that re-runnable SQL is still welcome.
10. As a developer, I want `COMMENT ON EXTENSION` refused, so that each extension keeps the comment its own install script writes.
11. As a developer, I want columns, defaults, indexes, constraints, views and routines in the desired schema to use an extension's types, functions, operators and operator classes unqualified, so that I write them as I would by hand.
12. As a developer, I want a reference to an extension's object that the extension doesn't provide at the pinned version refused as an unknown reference, so that I learn about it at `draft`, not at deploy.
13. As a developer, I want an index using an extension's operator class (such as `gin_trgm_ops`) always ordered after its `CREATE EXTENSION`, in every load order, so that the desired schema loads whatever the order-independence check tries.
14. As a developer, I want `validate` to apply the same extension rules as `draft`, so that I can check my desired schema without a database.

### Configuring the project

15. As a team lead, I want the config's `extensions` to list each supported extension the project may use and the versions it may use, so that only predetermined extensions and versions reach our databases.
16. As a team lead, I want a name in `extensions` that isn't a supported extension refused when the config loads, with the supported names listed, so that a typo fails at once.
17. As a team lead, I want a version the tool doesn't know refused when the config loads, naming the versions it does know (for example "citext 1.9 is not a supported version: supported versions are 1.4, 1.5, 1.6, 1.7, 1.8"), so that an impossible version never reaches a rehearsal.
18. As a team lead, I want to list more than one version for an extension, so that the project can move from one version to the next.
19. As a developer, I want finalized migrations to keep replaying after their version leaves the config, so that tightening the config never breaks history.
20. As a developer with no `extensions` in my config, I want everything to behave as today, so that the feature costs nothing until I use it.

### Drafting, rehearsing and finalizing

21. As a developer, I want `draft` to generate `CREATE EXTENSION <name> VERSION '<v>'` when the desired schema adds an extension, so that the schema change installs exactly the version I declared.
22. As a developer, I want `draft` to generate `ALTER EXTENSION <name> UPDATE TO '<v>'` when I raise the version, placed first in the schema change, so that later statements can use what the new version adds.
23. As a developer, I want lowering an extension's version refused at `draft`, explaining that PostgreSQL has no downgrade scripts, so that I don't produce a migration that can't run.
24. As a developer, I want `draft` to generate `DROP EXTENSION <name>` without `CASCADE` when I remove an extension, after statements dropping everything that used it, so that a reviewer sees each object that goes.
25. As a developer, I want removing an extension while something in the desired schema still uses it to fail as an unknown reference, so that I remove its uses explicitly.
26. As a developer, I want a rehearsal to fail when its server can't install the pinned version, naming the extension, the version and the versions the server offers, so that a rehearsal never proves a different version from the one a target gets.
27. As a developer, I want a rehearsal never to fall back to another version of an extension, so that what was rehearsed is exactly what deploys.
28. As a developer, I want the draft rehearsal, the deployment rehearsal and `finalize` to compare extensions and their versions like any other structure, so that a schema change that installs the wrong version can't be finalized.
29. As a reviewer, I want a migration's schema change to show `CREATE`, `ALTER ... UPDATE TO` and `DROP EXTENSION` statements with their versions, so that I review extension changes like any other change.
30. As a reviewer, I want a migration's snapshot to record each extension's version, so that the desired-schema diff shows a version change.

### Scripts and seed data

31. As a developer, I want my pre- and post-migration scripts to call a supported extension's functions, such as `digest()`, `crypt()` or `similarity()`, so that I can backfill data with them.
32. As a developer, I want calls to my own routines in scripts still refused, so that the existing rule against calling user-defined routines holds.
33. As a developer, I want `CREATE`, `ALTER` and `DROP EXTENSION` refused in pre-migration scripts, post-migration scripts and seed data, so that only the schema change touches extensions and nothing installs one the desired schema doesn't declare.

### Deploying

34. As a developer, I want `status`, `deploy` and `deploy-draft` to refuse up front, before any change, a target whose PostgreSQL doesn't offer a pinned version a pending migration (or the draft) installs. The message names the extension, the version and what the target offers, so that I don't find out halfway through a deployment.
35. As a developer, I want the same up-front refusal when the target's deploy role lacks `CREATE` on the database and a pending migration (or the draft) creates an extension. The message names the extension and the exact `GRANT` a DBA must run, so that a missing privilege is fixed before the deployment.
36. As a developer, I want no `CREATE` privilege check when nothing pending creates an extension, so that targets keep needing only what they need today.
37. As a developer, I want `status`, `deploy` and `deploy-draft` to refuse up front when a pending migration (or the draft) creates an extension the target already has in another schema. The message names that schema and the extension's owner, and says to move it with `ALTER EXTENSION ... SET SCHEMA` or drop it, so that a DBA's earlier installation doesn't fail the deployment.
38. As a developer on an older PostgreSQL target (the `postgresVersion` escape hatch), I want the same version pre-flight to refuse a pinned version the older server lacks (for example citext 1.8 on PostgreSQL 16), so that older targets need no special case.
39. As a DBA, I want a deployment that creates an extension to leave it owned by the deploy role, so that later deployments can update or drop it.

### Drift

40. As a DBA, I want any extension in a target's database that its recorded migrations didn't create to be drift, wherever it lives and whoever installed it, except `plpgsql`. That drift blocks `deploy`, `deploy-draft` and `mark`, so that a target's structure depends only on its recorded migrations.
41. As a DBA, I want `status` to report such an extension once, by name, schema and version, so that I know exactly what to remove.
42. As a DBA, I want a supported extension at a different version from the one its migrations installed to be drift, so that a hand-run `ALTER EXTENSION ... UPDATE` is caught.
43. As a DBA, I want an extension's member objects never listed one by one in drift, rehearsal differences or adoption refusals, so that one extension is one line, not dozens of functions and operators.
44. As a DBA, I want `rebuild` to refuse before YES when an extension outside the managed schema would survive the wipe, naming the extension and its schema, so that I don't rebuild into a target that can't be deployed to.
45. As a DBA, I want `rebuild` on a target whose deploy role lacks `CREATE` on the database to refuse before YES when the replay would create an extension, so that a rebuild never wipes and then fails.

### Adopting

46. As a developer adopting a database, I want a supported extension in the managed schema, at a version my config lists, written into the desired schema as `CREATE EXTENSION <name> VERSION '<v>'`, so that the adopted database's extensions come under management.
47. As a developer adopting a database, I want an extension that isn't supported, isn't listed in my config at its installed version, or lives outside the managed schema refused once, with the reason, so that I know what to change before adopting.
48. As a developer adopting a database, I want nothing written for an extension's member objects, so that the desired schema holds only the `CREATE EXTENSION`.

### Documentation

49. As a developer, I want the template README to list the supported extensions, the config key, the `VERSION` rule and the `CREATE`-on-database requirement, so that I can use them without reading the source.
50. As a developer, I want the README's list of refusals to say which extensions are refused and why, so that I understand the limit.

## Implementation Decisions

- **The supported set** is hard-coded in the library: the 17 names above, each with the versions it can be installed at, which are the versions embedded-postgres 18.4 offers (research file §1). A project's config can only narrow it. Supported extensions are the only extensions besides `plpgsql` that any part of the system accepts.
- **Generated object lists.** Ordering needs to know what each supported extension provides at each version: types, functions with their argument types, operators, operator classes and operator families. A generation script, alongside the one for `pg_catalog` names, produces this as committed source. It installs each supported extension at each installable version into a fresh embedded PostgreSQL 18.4 database and reads the extension's members. The same source is what the config validator treats as "the versions the tool knows".
- **Config.** A new optional `extensions` key: an object from supported-extension name to a non-empty list of version strings. The config resolver refuses unknown names, unknown versions, empty lists and duplicates, and it applies the empty default. The resolved config carries the key to the desired-schema rules.
- **Desired-schema rules.**
  - `CREATE EXTENSION` is accepted only for a supported extension that the config lists, with a `VERSION` the config lists for it. `SCHEMA` is accepted only when it names the managed schema, `CASCADE` is refused, and `IF NOT EXISTS` is accepted.
  - `CREATE EXTENSION plpgsql` keeps its current behaviour.
  - `COMMENT ON`, `ALTER` and `DROP EXTENSION` stay refused.
  - New refusals get rule ids in the rule catalogue, in the "unsupported" category, so they can't be overridden. Each refusal gets its README line and a row in the README-coverage test.
- **Ordering and references.**
  - A `CREATE EXTENSION` provides the objects its generated list gives at its pinned version.
  - Types, functions, operators and operator classes resolve against those lists before falling back to unknown-reference.
  - Operator classes in index elements, and operators in expressions, become references, so they get ordering edges to their extension.
  - The order-independence check's alternative order must keep every edge, so no load order can put a use before its extension.
- **The differ wrapper.** pg-delta emits `CREATE EXTENSION` without a version, and never emits version changes. After pg-delta's plan, super-deploy:
  - adds `VERSION '<v>'` to each `CREATE EXTENSION`, taken from the desired schema's catalog;
  - adds `ALTER EXTENSION ... UPDATE TO '<v>'` first in the schema change for each extension whose version rose between the two sides;
  - refuses at `draft` an extension whose version fell.

  The schema change is checked afterwards like any other.

  To verify while implementing: whether pg-delta emits `COMMENT ON EXTENSION` (it shouldn't, since both sides get the same comment from the install script) or `ALTER EXTENSION ... SET SCHEMA` (it shouldn't, since every extension lives in the managed schema). The deploy-time rules refuse both anyway.
- **Deploy-time rules.**
  - Schema changes may contain `CREATE EXTENSION` for a supported extension with `VERSION`, `ALTER EXTENSION ... UPDATE TO`, and `DROP EXTENSION` of a supported extension without `CASCADE`.
  - Scripts and seed data may contain no extension statement. `plpgsql` in pre-migration scripts also goes, since the desired schema now owns extensions.
  - `DROP EXTENSION` isn't destructive in itself: the statements that drop its users already carry the destructive warnings.
  - The `user-function-call` rule allows calls to functions a supported extension provides at a version the config lists. It still refuses everything else outside `pg_catalog`.
- **Rehearsals.** Throwaway databases stay as they are: created from `template0`, run as the rehearsal login, which is a superuser on embedded-postgres. Loading the desired schema runs its `CREATE EXTENSION ... VERSION` statements in order. When the rehearsal server lacks the version, the rehearsal fails with a typed error naming the extension, the version and what the server offers. It never retries without the version.
- **Catalog comparison.**
  - Every fact kind leaves out extension members (pg_depend deptype `e`): routines, types, relations, columns, comments, dependencies and the existing "other" query.
  - Extensions become their own facts, read across the whole database rather than the managed schema: name, schema and version. `plpgsql` in `pg_catalog` is excluded.
  - Rehearsal comparisons, drift and `mark` share this, so all three see an extension as one fact.
  - An extension outside the managed schema is drift labelled with its schema.
- **Pre-flight**, for `status`, `deploy` and `deploy-draft`, over what the pending migrations (or the draft) would run:
  - (a) Every `CREATE EXTENSION ... VERSION` and `UPDATE TO` version is in the target's `pg_available_extension_versions`.
  - (b) If anything creates an extension, the deploy role has `CREATE` on the database.
  - (c) No extension that would be created already exists in another schema.

  Each check gets a typed error, exported, with a one-line message. They run before the deploy transaction, as the existing pre-flight checks do, and `status` reports them without changing anything.
- **Rebuild.** Before YES, `rebuild` refuses:
  - when an extension outside the managed schema exists, because it would survive the wipe and be drift;
  - when the replay would create an extension and the deploy role lacks `CREATE` on the database.

  The wipe already drops extensions in the managed schema.
- **Ownership.** The ownership checks already skip extension members. Their documented assumption that a deployment never alters or drops an extension is replaced: the deploy role owns each extension it created, and that is what lets it update or drop one. An extension in the managed schema that isn't owned by the deploy role (or a role it belongs to) is refused by the existing ownership pre-flight.
- **Adoption.** A supported extension in the managed schema, at a version the config lists, becomes `CREATE EXTENSION <name> VERSION '<v>';` in the generated desired schema, and its members are left out. Any other extension stays a single refusal, with a reason saying which test it fails: not supported, not listed in the config at that version, or outside the managed schema.
- **Errors.** Every new refusal is a `SuperDeployError` subclass in the module that throws it, with a stable kebab-case code, exported from the public API.
- **Docs.** The template README gains:
  - the supported extensions and the `extensions` config key;
  - the `VERSION` rule, and how a version change becomes `UPDATE TO`;
  - `CREATE` on the database whenever a migration creates an extension, in the Permissions section;
  - the database-wide drift rule.

  Its list of refusals updates. GLOSSARY, ADR-0009 and REFINEMENTS are already written.

## Testing Decisions

- **What a good test is.** Tests check behaviour a user sees through the public API: files `draft` writes, errors and their codes and messages, what a target holds after `deploy`, what `status` reports. They don't check internal functions, query shapes or intermediate structures. They use existing helpers and seams only.
- **Seam 1, the programmatic API against real PostgreSQL 18, is the main seam:**
  - config refusals (unknown name, unknown version);
  - `draft` generating `CREATE EXTENSION ... VERSION`, `UPDATE TO` first on a raised version, refusal of a lowered version, and `DROP EXTENSION` without `CASCADE` after its users' drops;
  - rehearsal and `finalize` round trips with an extension;
  - drift for a hand-installed extension in another schema (`pg_stat_statements` or `citext` in `public`, installed as the superuser) and for a hand-updated version;
  - the three pre-flight refusals: version unavailable, missing `CREATE`, already installed elsewhere;
  - one fact per extension, with no members, in drift output;
  - `adopt` writing `CREATE EXTENSION ... VERSION` and refusing the other cases;
  - scripts calling extension functions.
- **Two version gaps get real or injected servers:**
  - **A target that lacks the pinned version** is the existing PostgreSQL 16 test server, where citext stops at 1.6, so `VERSION '1.8'` is refused at pre-flight.
  - **A rehearsal server that lacks a version** is fault injection on the rehearsal adapter, the existing `rehearsal:` wrapper pattern, because embedded 18.4 offers every version the tool knows.
- **Seam 3, SQL analysis with no database:**
  - desired-schema rules (`VERSION` required, config allowlist, `SCHEMA`, `CASCADE`, `COMMENT ON EXTENSION`);
  - deploy-time rules (the three schema-change forms allowed, every extension statement refused in scripts and seed data, extension function calls allowed in scripts);
  - ordering fixtures proving an index using `gin_trgm_ops`, a column of type `citext` and a default calling `gen_random_uuid` alongside `pgcrypto` functions all load after their extension in both load orders;
  - every pg-delta schema-change fixture with an extension passing as a schema change.
- **Seam 2, the CLI pseudo-terminal:** one test that `rebuild` refuses before YES when an extension sits outside the managed schema.
- **Prior art:**
  - desired-schema and deploy-time rule tests in `test/unit/sql-analysis/` and `test/integration/desired-schema-rules.test.ts`;
  - ordering fixtures in `test/fixtures/ordering.ts`;
  - `drift.test.ts`, `preflight.test.ts`, `target-privileges.test.ts` (privileges changed by hand on a target);
  - `adopt.test.ts`, whose citext and pgcrypto refusal tests change to the new behaviour;
  - `postgres-16.test.ts`;
  - the fault-injection wrappers in `failure-handling.test.ts`;
  - `cli-deploy-draft-rebuild.test.ts` (rebuild refusals before YES, including superuser-owned extensions);
  - `config.test.ts`;
  - the README-coverage test for refusals.
- **Existing tests that change.** Tests asserting that `citext` or `pgcrypto` are refused in the desired schema, in deploy-time SQL or in adoption are updated to the new rules. Tests that need any extension refused switch to one that isn't supported (for example `earthdistance` or `pg_stat_statements`).

## Out of Scope

- **Extensions outside the supported set:**
  - Third-party extensions (PostGIS, pgvector, pg_partman), and any extension that isn't trusted or that needs `shared_preload_libraries`.
  - `lo`, `seg` and `tcn`, until Aurora 18.4 is confirmed to trust them. Ticket 11 confirmed it; adding them is a later ticket.
  - `plperl` and `pltcl`, because embedded-postgres doesn't bundle their language libraries.
- **Extensions outside the managed schema,** a dedicated extensions schema, or extensions in external schemas.
- **A config list of extensions to ignore on targets** (for monitoring extensions such as `pg_stat_statements`). Recorded in REFINEMENTS.
- **Other changes to extensions:** downgrading an extension, `ALTER EXTENSION ... ADD`, `DROP` or `SET SCHEMA`, and `DROP EXTENSION ... CASCADE`.
- **Running rehearsals as a deploy-like, non-superuser role.**
- **Confirming Aurora's real extension versions on a live cluster.** That is a separate `ready-for-human` ticket; it doesn't block this spec.

## Further Notes

- **Aurora versions were unconfirmed when this spec was written.** AWS's published Aurora 18 extension versions looked stale: they differ from community 18.4 for 12 contrib extensions and match its 17.11 rows (research file §6). Nothing in this spec depends on which is right, because versions are pinned and checked against each target at pre-flight. Ticket 11 later found the table stale: Aurora 18.4 offers exactly the versions the tool knows.
- **Embedded-postgres versions limit the tool.** The versions the tool knows are the ones embedded-postgres 18.4 can install. Moving to a newer embedded-postgres means regenerating the object lists, which may add versions.
- **Members aren't the deploy role's.** A trusted extension's member objects are owned by PostgreSQL's bootstrap superuser (`rdsadmin` on Aurora), not the deploy role. Nothing in super-deploy alters member objects, so this is only something not to trip over.
