# 09: Migration store and validate

Status: ready-for-agent
Type: task
Blocked by: 02
Spec: ../spec.md

## What

On-disk layout, naming, hashing, chain, `meta.json`, read-only files and the `validate` command (spec §3, §6).

## Acceptance criteria

- [ ] Layout and naming per §3 and §3.1.
- [ ] UTF-8 (BOM refused), LF normalisation, SHA-256 content hash over files + folder name, chain in `index.json`.
- [ ] `fs.chmod(0o444)` on finalize, verified on Windows.
- [ ] `validate [--strict]` checks index, hashes, chain, read-only state, rules and overrides; warns about the draft and undrafted changes.
- [ ] Template: `.gitattributes`, `files.readonlyInclude`, precommit with `validate --strict`.
