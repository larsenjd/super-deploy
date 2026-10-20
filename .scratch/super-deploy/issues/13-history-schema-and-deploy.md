# 13: History schema and deploy

Status: ready-for-agent
Type: task
Blocked by: 05, 09, 04
Spec: ../spec.md

## What

The history schema and `deploy --target` (spec §7.1–§7.5).

## Acceptance criteria

- [ ] History schema created by the first deploy inside its transaction; tables per §7.1.
- [ ] Attempt log on a second connection; outcomes `running`/`succeeded`/`failed`/`abandoned`/`unknown`.
- [ ] Advisory lock via `pg_try_advisory_lock`; fails fast naming the holding attempt.
- [ ] Pre-flight: missing roles refuse; missing external schemas refuse; privileged deploy role warns; recorded hashes verified.
- [ ] Drift check against a locale-matched replica; any drift refuses.
- [ ] Rehearsal of pending migrations then one transaction on the target with pinned settings and `SET CONSTRAINTS ALL IMMEDIATE` per migration boundary.
- [ ] Unknown COMMIT outcome recorded and settled on next run.
- [ ] Integration tests for success, script failure (full rollback, attempt recorded), drift refusal, lock contention, interruption.
