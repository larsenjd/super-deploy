# Supported extensions are a fixed trusted set, pinned by version, and every extension in a target is managed

The desired schema may install a supported extension. That is one of 17 extensions shipped with PostgreSQL that pass four tests: they are trusted, so the deploy role can install them without being a superuser; Aurora PostgreSQL 18.4 offers them; they load on every embedded-postgres platform; and they stay inside the deploy transaction. Each one lives in the managed schema. Every `CREATE EXTENSION` must state its `VERSION`, and the project's config lists which supported extensions and versions it allows. Any extension in a target's database that its recorded migrations didn't create is drift, wherever it lives, except `plpgsql`.

We hard-coded the set rather than making it configurable, because install scripts are code the parser can't see (ADR-0002). The tool checks each extension once, for privileges, transactions and rehearsal parity, so a project's config can only narrow the set. We pinned versions because the same `CREATE EXTENSION` installs different default versions on different servers. pg-delta ignores versions, so citext 1.6 on Aurora and 1.8 in a rehearsal would otherwise pass as identical.

The version goes in the desired schema rather than only in the config because snapshots are the desired schema. A version held only in the config would change the structure without any migration recording it. We made every extension in the database managed, not only those in the managed schema, so that a target's structure depends only on its recorded migrations.

## Considered options

- **Ignore versions, as pg-delta does.** Rejected: rehearsals would prove a different structure from the one targets get.
- **The config as the only place a version is set.** Rejected for the snapshot reason above.
- **A dedicated extensions schema, or extensions in external schemas.** Rejected:
  - A second schema the system owns is new machinery.
  - External schemas aren't reproduced in rehearsals, so columns and defaults couldn't use an extension's types or functions.
- **Untrusted extensions installed through `rds_superuser`.** Rejected: the deploy role would need rights ADR-0006 keeps away from it, and rehearsals, which run as a superuser, couldn't show what a target refuses.
- **A config list of extensions to ignore on targets, for monitoring extensions such as `pg_stat_statements`.** Deferred to REFINEMENTS "Extensions".

## Consequences

- **A pinned version is never replaced.** A rehearsal fails if its server can't install it. `status`, `deploy` and `deploy-draft` refuse, before any change, a target whose `pg_available_extension_versions` lacks it.
- **The config is checked when it loads.** `resolveConfig` refuses an extension outside the supported set, and a version the tool has no list of names for.
- **Only the desired schema is checked against the config.** Finalized migrations replay as recorded, even after their version leaves the config.
- **Changing a version is a schema change.**
  - `draft` adds `ALTER EXTENSION ... UPDATE TO` itself, first in the schema change, since pg-delta never emits it.
  - A lower version is refused, because PostgreSQL ships no downgrade scripts.
- **Removing an extension.** `DROP EXTENSION` without `CASCADE` is allowed in schema changes only. Everything that used the extension is dropped by its own statement first, so a reviewer sees each change.
- **Only the schema change touches extensions.** Scripts and seed data may never create, alter or drop one, though scripts may call a supported extension's functions.
- **Ordering has to know what each extension provides.** It needs a generated list of each supported extension's types, functions, operators and operator classes at each version, alongside `pg-catalog-names.ts`.
- **The catalog comparison changes in two ways.**
  - It leaves extension members out of every kind of fact. Each extension appears once, with its name and version.
  - It reads extensions across the whole database, not only in the managed schema.
- **A database already used for monitoring or by another app** can't be deployed to until its extra extensions are removed.
  - An extension that is already installed elsewhere in the target's database, when a migration would create it, is refused up front with how to move or drop it.
  - `rebuild` refuses before YES when an extension outside the managed schema would survive the wipe.
- **The deploy role needs `CREATE` on the database** whenever a command would create an extension. `status`, `deploy`, `deploy-draft` and `rebuild` check it up front.
- **Ownership (ADR-0006).** The deploy role owns each extension, but PostgreSQL gives the members to its bootstrap superuser, and the deploy role can't alter them. The ownership checks already skip members. A deployment can now drop or update an extension, which the deploy role may do as the extension's owner.
- **Older targets (ADR-0007) need no special case.** A target on an older PostgreSQL that lacks a pinned version is refused by the same pre-flight check.
- **Adoption.** `adopt` writes `CREATE EXTENSION ... VERSION` for a supported extension in the managed schema at a version the config lists, and refuses any other extension.
- **The set is tied to Aurora 18.4, and a real cluster confirmed it** on 2026-11-14 (`.scratch/extensions/issues/11-confirm-supported-set-on-aurora.md`). All 17 are present and trusted there, at exactly the versions the tool knows.
  - AWS's published versions for Aurora 18 contrib extensions are stale. When the set or PostgreSQL's version changes, check a cluster, not AWS's table (`.scratch/extensions/research/supported-extensions.md` §6).
  - Installing as a role without `rds_superuser` wasn't tried on Aurora. That it works rests on every supported version reporting `trusted`.
  - Aurora also trusts `lo`, `seg` and `tcn`, though AWS's list leaves them out. They stay out of the set until a team needs them (REFINEMENTS "Extensions").
