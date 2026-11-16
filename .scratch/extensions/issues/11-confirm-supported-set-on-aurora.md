# 11: Confirm the supported set on Aurora 18.4

**What to build:** Confirm, or correct, the supported set and versions the agent chose from documentation, using a real Aurora PostgreSQL 18.4 cluster.

The agent's choices are in research file §1 and ticket 01's generated source, which together give the 17 extensions and their versions. Two things in them are unverified:
- AWS's published Aurora 18 extension versions look stale (research file §6). For 12 contrib extensions they differ from community 18.4 and match Aurora 17.11. Of the 17, these are `btree_gist`, `citext`, `fuzzystrmatch`, `isn` and `pgcrypto`.
- AWS's trusted list leaves out `lo`, `seg` and `tcn`, which community PostgreSQL trusts.

Nothing built so far depends on which is right, because versions are pinned and pre-flight checks every target. This ticket settles what the docs, and a team choosing versions, should expect on Aurora.

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09, 10

**Status:** resolved

- [x] Run ticket 01's check script, as its header describes, against an Aurora PostgreSQL 18.4 cluster (any 18.4.x patch, noted in the comments below), connected as an ordinary role with `CREATE` on a database, not `rds_superuser`.
- [x] Record the report under `## Comments` below: for each of the 17 supported extensions, whether it's present, whether it's trusted, and the versions Aurora offers.
- [x] Also record, from `select name, version, trusted from pg_available_extension_versions where name in ('lo', 'seg', 'tcn')`, whether Aurora trusts `lo`, `seg` and `tcn`.
- [x] As the role with only `CREATE` on the database, install one supported extension at a version the report shows. For example, `create extension citext version '<v>'` in a scratch database, then `drop extension citext`. This confirms a non-`rds_superuser` deploy role can install it.
- [x] Decide, and record the decision here:
  - **Everything matches:** close this ticket.
  - **An extension is missing or untrusted on Aurora:** remove it from the supported set.
  - **Aurora offers versions the tool doesn't know:** nothing to do, because they can't be rehearsed.
  - **`lo`, `seg` or `tcn` are trusted and present:** decide whether to add them.

  Any change becomes a follow-up `ready-for-agent` ticket that updates the supported set, the generated source, research file §1 and §6, ADR-0009's last consequence, and REFINEMENTS "Extensions".

## Comments

### 2026-11-14: report from Aurora PostgreSQL 18.4

Run by hand rather than with the check script: the script's query (`pg_available_extension_versions`) plus `rds.allowed_extensions` and `server_version`, pasted back and compared with `src/sql-analysis/supported-extensions.ts`.

- `server_version`: 18.4. `rds.allowed_extensions`: `*`, so nothing is forbidden.
- **All 17 supported extensions match.** Each is present, trusted at every version, and offers exactly the versions the tool knows:
  btree_gin 1.0–1.3, btree_gist 1.2–1.8, citext 1.4–1.8, cube 1.2–1.5, dict_int 1.0, fuzzystrmatch 1.1–1.2, hstore 1.4–1.8, intarray 1.2–1.5, isn 1.1–1.3, ltree 1.1–1.3, pg_trgm 1.3–1.6, pgcrypto 1.3–1.4, tablefunc 1.0, tsm_system_rows 1.0, tsm_system_time 1.0, unaccent 1.1, uuid-ossp 1.1.
- **AWS's published Aurora 18 versions are stale, as research file §6 suspected.** `btree_gist`, `citext`, `fuzzystrmatch`, `isn` and `pgcrypto` offer the community 18.4 versions, not the Aurora 17.11 ones the docs list.
- **`lo`, `seg` and `tcn` are present and trusted**, unlike AWS's trusted list: lo 1.1–1.2, seg 1.1–1.4, tcn 1.0.
- **Install test: waived.** `create extension citext` then `drop extension citext` succeeded, but as a member of `rds_superuser`. The maintainer decided not to re-run it as a role without `rds_superuser`: deploy roles are assumed to have the permissions they need. Every supported extension reports `trusted` at every version, so a role with only `CREATE` on the database should be able to install them too. That is unconfirmed on Aurora.
- **Decision: everything matches, so the supported set stays as it is.** `lo`, `seg` and `tcn` are not added for now, though Aurora offers and trusts them. Adding them later is a new ticket. No follow-up ticket.
