# Every pending migration deploys in one transaction

A deployment applies all of a target's pending migrations inside a single transaction, so the target either reaches the newest migration or is left exactly as it was. We chose this over one transaction per migration because a half-deployed target (some migrations applied, a later one failed) is the hardest state to reason about and recover from.

## Consequences

- Nothing that cannot run inside a transaction block is allowed, with no escape hatch: no `CONCURRENTLY` operations, no `VACUUM`, no enum values added and then used. Building an index on a large existing table blocks writes to it until the deployment commits, and building it out-of-band instead is not supported (it counts as drift).
- Every lock taken by any pending migration is held until the final commit, so "add `NOT VALID`, then validate" gains nothing inside a deployment.
- A failed deployment still records its attempt, because the attempt log is written outside the deploy transaction. The history schema itself is created too (if missing) on its own, before the attempt is opened and so before the deploy transaction, not inside it: otherwise a target's failed first deployment would roll back the very tables its attempt is recorded in.

Narrowings to revisit after V1 are in `REFINEMENTS.md`.
