# 11: Destructive acknowledgement and warnings

**What to build:** `finalize` stops a draft that drops structure or deletes data until the developer acknowledges it, and warns about statements that will rewrite or scan existing tables while holding locks.

**Blocked by:** 06

**Status:** resolved

**Spec:** `../spec.md`

- [ ] Destructive: `DROP …`, dropping a column, lossy column type changes, `DELETE`, `TRUNCATE`.
- [ ] Refused unless `--acknowledge-destructive` is passed or confirmed at the prompt; acknowledgement and its statements recorded in metadata.
- [ ] Warnings for `ALTER COLUMN TYPE`, volatile defaults, `SET NOT NULL`, constraint validation, `CREATE INDEX` and `TRUNCATE` on existing tables; tables created in the same migration exempt.
- [ ] No warnings for volatile functions.
