# 13: Deploy pre-flight checks

**What to build:** Before touching a target, `deploy` and `status` catch what would otherwise fail mid-transaction or weaken safety: missing roles, missing external schemas, a privileged deploy role, or history that doesn't match the repo.

**Blocked by:** 04, 08

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] Rehearsals create any missing granted role as `NOLOGIN` and never drop it; grants on managed objects are diffed, ownership is not.
- [ ] `deploy` refuses when a granted role or a declared external schema is missing on the target; `status` reports them.
- [ ] Warning when the deploy role is superuser or holds `pg_write_server_files`, `pg_execute_server_program` or `pg_signal_backend`.
- [ ] Recorded hashes on the target must match the repo, otherwise refuse.
