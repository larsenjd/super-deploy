# 07: Rules desired schema and plpgsql

Status: ready-for-agent
Type: task
Blocked by: 06
Spec: ../spec.md

## What

Desired-schema rule set (spec §4.1) and PL/pgSQL body rules (spec §4.3).

## Acceptance criteria

- [ ] Only allowed statements and supported object types; every refused type in §4.1 has a fixture.
- [ ] PL/pgSQL bodies parsed; `EXECUTE`, `COMMIT`/`ROLLBACK`, denylisted calls and undeclared schema references refused.
- [ ] `externalSchemas` from config honoured; references from non-PL/pgSQL objects left for PostgreSQL to reject in rehearsal, with a helpful hint in the error.
