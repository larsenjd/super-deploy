# 03: Finalize and validate

**What to build:** A developer runs `finalize` and the draft is rehearsed, then frozen as migration `00001-add-customers`: read-only files, metadata, a desired-schema snapshot and a hash-chain entry. `validate --strict` fails if anyone edits or renames a finalized migration, and runs in the example project's pre-commit.

**Blocked by:** 02

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] `rehearse` and `finalize` replay every finalized migration plus the draft on a throwaway database and require an empty diff against the desired schema, using both pg-delta and our own engine-independent `pg_catalog` comparison.
- [ ] Finalized folder name: five-digit zero-padded number, hyphen, description.
- [ ] Metadata records tool, differ and parser versions and the rehearsal server version; no timestamps or usernames.
- [ ] Hashing: UTF-8 with BOM refused, LF-normalised, SHA-256 over every file and the folder name, chained to the previous migration.
- [ ] Finalized files are read-only on Linux, macOS and Windows.
- [ ] `validate` checks index, hashes, chain and read-only state; warns about an unfinalized draft and undrafted desired-schema changes; `--strict` turns warnings into failures.
- [ ] A change that differs only in line endings does not fail `validate`; a content edit or folder rename does.
- [ ] The example project's precommit runs Biome check, typecheck and `validate --strict`.
