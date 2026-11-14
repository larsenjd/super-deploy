# 11: Confirm the supported set on Aurora 18.4

**What to build:** Confirm, or correct, the supported set and versions the agent chose from documentation, using a real Aurora PostgreSQL 18.4 cluster.

The agent's choices are in research file §1 and ticket 01's generated source, which together give the 17 extensions and their versions. Two things in them are unverified:
- AWS's published Aurora 18 extension versions look stale (research file §6). For 12 contrib extensions they differ from community 18.4 and match Aurora 17.11. Of the 17, these are `btree_gist`, `citext`, `fuzzystrmatch`, `isn` and `pgcrypto`.
- AWS's trusted list leaves out `lo`, `seg` and `tcn`, which community PostgreSQL trusts.

Nothing built so far depends on which is right, because versions are pinned and pre-flight checks every target. This ticket settles what the docs, and a team choosing versions, should expect on Aurora.

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09, 10

**Status:** ready-for-human

- [ ] Run ticket 01's check script, as its header describes, against an Aurora PostgreSQL 18.4 cluster (any 18.4.x patch, noted in the comments below), connected as an ordinary role with `CREATE` on a database, not `rds_superuser`.
- [ ] Record the report under `## Comments` below: for each of the 17 supported extensions, whether it's present, whether it's trusted, and the versions Aurora offers.
- [ ] Also record, from `select name, version, trusted from pg_available_extension_versions where name in ('lo', 'seg', 'tcn')`, whether Aurora trusts `lo`, `seg` and `tcn`.
- [ ] As the role with only `CREATE` on the database, install one supported extension at a version the report shows. For example, `create extension citext version '<v>'` in a scratch database, then `drop extension citext`. This confirms a non-`rds_superuser` deploy role can install it.
- [ ] Decide, and record the decision here:
  - **Everything matches:** close this ticket.
  - **An extension is missing or untrusted on Aurora:** remove it from the supported set.
  - **Aurora offers versions the tool doesn't know:** nothing to do, because they can't be rehearsed.
  - **`lo`, `seg` or `tcn` are trusted and present:** decide whether to add them.

  Any change becomes a follow-up `ready-for-agent` ticket that updates the supported set, the generated source, research file §1 and §6, ADR-0009's last consequence, and REFINEMENTS "Extensions".
