# Supported extensions: research for PostgreSQL 18.4 on Aurora and embedded-postgres

Gathered 2026-11-13 while grilling the extensions feature. Decisions are in ADR-0009; this file holds the facts behind them.

## 1. Choosing the supported set

An extension is supported only if all four hold:

1. **Trusted** in PostgreSQL 18 (`trusted = true` in its control file), so the deploy role, which isn't a superuser, can install it with `CREATE` on the database.
2. **Listed for Aurora PostgreSQL 18.4.**
3. **Loads on every embedded-postgres platform**: its control file and its shared library's dependencies are all present.
4. **Stays inside the deploy transaction**: no `shared_preload_libraries`, no background workers, no effects a rollback can't undo.

The 17 that pass, with the versions embedded-postgres 18.4 can install (from `pg_available_extension_versions` on a live embedded 18.4 server, linux-x64) and the version AWS lists for Aurora 18.4:

| Extension | Embedded 18.4 installable | Embedded default | Aurora 18.4 (AWS doc) |
|---|---|---|---|
| btree_gin | 1.0–1.3 | 1.3 | 1.3 |
| btree_gist | 1.2–1.8 | 1.8 | 1.6 |
| citext | 1.4–1.8 | 1.8 | 1.6 |
| cube | 1.2–1.5 | 1.5 | 1.5 |
| dict_int | 1.0 | 1.0 | 1.0 |
| fuzzystrmatch | 1.1–1.2 | 1.2 | 1.1 |
| hstore | 1.4–1.8 | 1.8 | 1.8 |
| intarray | 1.2–1.5 | 1.5 | 1.5 |
| isn | 1.1–1.3 | 1.3 | 1.2 |
| ltree | 1.1–1.3 | 1.3 | 1.3 |
| pg_trgm | 1.3–1.6 | 1.6 | 1.6 |
| pgcrypto | 1.3–1.4 | 1.4 | 1.3 |
| tablefunc | 1.0 | 1.0 | 1.0 |
| tsm_system_rows | 1.0 | 1.0 | 1.0 |
| tsm_system_time | 1.0 | 1.0 | 1.0 |
| unaccent | 1.1 | 1.1 | 1.1 |
| uuid-ossp | 1.1 | 1.1 | 1.1 |

Every Aurora version AWS lists is installable on embedded-postgres. The AWS column turned out to be stale: on a real Aurora 18.4 cluster, each of the 17 offers exactly the embedded range (§6).

### Excluded, and why

- **Trusted, but not on AWS's trusted list:** `lo`, `seg`, `tcn`. AWS's list is incomplete: Aurora 18.4 trusts all three (§6). They are left out until a team needs them (REFINEMENTS "Extensions").
- **Trusted, but their language library isn't bundled:** `plperl`, `pltcl`, `bool_plperl`, `jsonb_plperl` (libperl and libtcl are missing in embedded-postgres; see §3).
- **Untrusted, so they need a superuser or `rds_superuser`:** everything else, including `earthdistance`, which the old REFINEMENTS candidate list named. Among these, the ones that also break the transaction or need preloading: `dblink`, `postgres_fdw`, `pg_stat_statements` (its functions need `shared_preload_libraries`), `pg_prewarm` (autoprewarm needs preloading).
- **Not on Aurora 18.4:** `file_fdw`, `xml2`, `plpython3u`, `pageinspect`, `pg_surgery`, `pg_walinspect`, `pg_logicalinspect`.
- `plpgsql` is installed in every database and stays as it is: it lives in `pg_catalog`, not the managed schema.

## 2. Installing an older version works

Tested on embedded-postgres 18.4 (linux-x64), as a non-superuser role that owns the database:

- `CREATE EXTENSION citext VERSION '1.6'`, `pgcrypto '1.3'`, `btree_gist '1.6'`, `fuzzystrmatch '1.1'`, `isn '1.2'` and `lo '1.1'` all succeeded, in one transaction with `COMMIT`. PostgreSQL runs the base install script and then the update scripts up to the version asked for.
- A version below the base install script fails: `CREATE EXTENSION hstore VERSION '1.3'` gives `extension "hstore" has no installation script nor update path for version "1.3"`.
- `ALTER EXTENSION citext UPDATE TO '1.8'` by the same non-superuser succeeded.
- Only the SQL definitions are older. The shared library is always the server's own 18.4 build, on embedded-postgres and on Aurora alike, so the same pinned SQL version should give identical catalogs.
- PostgreSQL ships no downgrade scripts.

## 3. embedded-postgres binaries by platform

`embedded-postgres` 18.4.0-beta.17 downloads `io.zonky.test.postgres:embedded-postgres-binaries-<platform>-<arch>:18.4.0` from Maven Central (`packages/downloader/src/index.ts` at tag `v18.4.0-beta.17` in github.com/leinelissen/embedded-postgres).

zonkyio/embedded-postgres-binaries builds them two ways:
- **Linux:** built from source with `--with-ossp-uuid --with-libxml --with-libxslt --with-perl --with-python --with-tcl` and `make -C contrib install`.
- **macOS and Windows:** EDB's binary zips, repackaged.

Every platform ships the same 60 community control files (macOS adds EDB's `pldbgapi` and `system_stats`; Windows adds `pldbgapi`). Some shared libraries don't load because a library they link to isn't bundled:

| Extension | Linux | macOS | Windows |
|---|---|---|---|
| uuid-ossp | works | works | works |
| xml2 | works | needs `libxslt.1.dylib`, not bundled | works |
| plperl | needs `libperl.so.5.26`, not bundled | needs EDB Language Pack | needs `perl542.dll`, not bundled |
| pltcl | needs the system's `libtcl8.6.so` | needs EDB Language Pack | needs `tcl86t.dll`, not bundled |
| plpython3u | needs `libpython3.6m.so.1.0`, not bundled | needs libpython3.13, not bundled | needs `python313.dll`, not bundled |

The Linux rows were confirmed with `ldd`. The macOS and Windows rows come from the library references inside the binaries; those platforms weren't run. All 17 supported extensions are plain C or SQL with no external library except `uuid-ossp`, which works everywhere.

## 4. Who can install an extension

**PostgreSQL 18** (https://www.postgresql.org/docs/18/sql-createextension.html):

> "if the extension is marked trusted in its control file, then it can be installed by any user who has CREATE privilege on the current database. In this case the extension object itself will be owned by the calling user, but the contained objects will be owned by the bootstrap superuser (unless the extension's script explicitly assigns them to the calling user). This configuration gives the calling user the right to drop the extension, but not to modify individual objects within it."

Confirmed on embedded 18.4: the extension's owner was the installing role, and its member functions (`citextin`, `citextout`) were owned by the bootstrap superuser.

- `DROP EXTENSION` and `ALTER EXTENSION ... UPDATE` need only ownership of the extension. For a trusted extension, the update script runs as the bootstrap superuser, but only while the caller still has `CREATE` on the database (`src/backend/commands/extension.c` at `REL_18_4`).
- `ALTER EXTENSION ... ADD` / `DROP` also need ownership of the member object, which the installer doesn't have.

**RDS and Aurora** (https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.Extensions.html):

- Most extensions need `rds_superuser`. Trusted extensions can be installed by any role with `CREATE` on the database. AWS's trusted list: bool_plperl, btree_gin, btree_gist, citext, cube, dict_int, fuzzystrmatch, hstore, intarray, isn, jsonb_plperl, ltree, pg_trgm, pgcrypto, plperl, plpgsql, pltcl, tablefunc, tsm_system_rows, tsm_system_time, unaccent, uuid-ossp. It is a subset of community's: `lo`, `seg`, `tcn` and `hstore_plperl` are missing from it. The list is incomplete: Aurora 18.4 trusts `lo`, `seg` and `tcn` in practice (§6).
- `rds.allowed_extensions` (default `*`, dynamic) can restrict what may be installed. A restricted extension fails with `permission denied to create extension ... HINT: This extension is not specified in "rds.allowed_extensions"`.
- Delegated extensions (`rds_extension` role plus `rds.allowed_delegated_extensions`, empty by default) are a third route: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora_delegated_ext.html.

## 5. Transactions

`CREATE EXTENSION` runs inside a transaction block; extension scripts "are implicitly executed within a transaction block" (https://www.postgresql.org/docs/18/extend-extensions.html). None of the 17 supported extensions preloads, starts a worker, or depends on another extension.

## 6. Aurora's real versions

Aurora PostgreSQL 18.4 was released on 2026-08-21 (patches 18.4.1–18.4.3 followed). AWS's version table (https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html) lists Aurora 18 contrib versions that differ from community 18.4 for 12 extensions: amcheck, btree_gist, citext, fuzzystrmatch, isn, lo, pg_buffercache, pgcrypto, pg_freespacemap, pg_stat_statements, postgres_fdw, seg. Those Aurora 18 rows are identical to its 17.11 rows (even `seg` is listed at 1.0, while community has shipped 1.4 for years), and Aurora's 18.x release notes mention version changes only for third-party extensions. So the table was probably copied forward rather than updated.

It was. On 2026-11-14 a real Aurora 18.4 cluster (`rds.allowed_extensions` = `*`) gave, from `pg_available_extension_versions` (full report in `.scratch/extensions/issues/11-confirm-supported-set-on-aurora.md`):

- **All 17 supported extensions** are present, trusted at every version, and offer exactly the embedded-postgres 18.4 ranges in §1. `btree_gist`, `citext`, `fuzzystrmatch`, `isn` and `pgcrypto` offer the community versions, not the 17.11 ones AWS lists.
- **`lo` 1.1–1.2, `seg` 1.1–1.4 and `tcn` 1.0** are present and trusted, though AWS's trusted list (§4) leaves them out.
- **Not checked:** installing as a role without `rds_superuser`. The test install ran as a member of `rds_superuser`.

AWS's table is not a reliable source for Aurora's contrib versions. Check a cluster instead.

## 7. Where the code is affected today

All paths are under `packages/super-deploy/src/`.

- **Desired-schema rules:** `sql-analysis/desired-schema-rules.ts` (`checkExtension`) refuses any extension but `plpgsql`, and any option on `plpgsql`. `COMMENT ON EXTENSION` is refused.
- **Deploy-time rules:** `sql-analysis/deploy-time.ts` refuses `CREATE EXTENSION` for anything but `plpgsql`, plus every `ALTER EXTENSION` and `DROP EXTENSION`. A script calling a function outside `pg_catalog` is refused as `user-function-call`.
- **Ordering:**
  - `ordering.ts`'s `builtIn()` knows only `pg-catalog-names.ts`, which is generated from `pg_catalog`. So `citext` or `gen_salt()` would be `unknown-reference`.
  - Operator classes (`gin_trgm_ops`) and operators aren't references at all.
  - `alternativeTieBreak` ignores the extensions-first priority, so the order-independence check could load an index before its extension.
- **Throwaway databases:** created from `template0` and run as the rehearsal login, a superuser on embedded-postgres. The `search_path` is pinned to `"<managed>", pg_catalog`, so an unqualified `CREATE EXTENSION` lands in the managed schema.
- **Differ:** pg-delta 1.0.0-alpha.59.
  - It diffs extensions: `CREATE EXTENSION x [SCHEMA s]`, `DROP EXTENSION x`, `ALTER EXTENSION ... SET SCHEMA`.
  - It leaves out extension members and orders `CREATE EXTENSION` before anything that uses them.
  - It ignores versions and never emits `VERSION` or `CASCADE`.
  - Not verified: whether it emits `COMMENT ON EXTENSION`.
- **Catalog comparison:**
  - `verification/catalog.ts` reads only the managed schema.
  - Only its `other` query skips extension members. `routine`, `type`, `relation`, `comment` and `depends` don't.
  - The extension's fact includes its version.
- **Ownership and wipe:**
  - `deploy/ownership.ts` already skips extension members. Its header says a deployment never alters or drops an extension, which is no longer true.
  - `deploy/wipe.ts` already drops extensions in the managed schema.
- **Pre-flight:** no extension or `CREATE`-privilege check. Only the major version is checked.
- **Adoption:** `commands/adopt.ts` refuses an extension once, with the reason "Extensions other than plpgsql are not supported in V1".
