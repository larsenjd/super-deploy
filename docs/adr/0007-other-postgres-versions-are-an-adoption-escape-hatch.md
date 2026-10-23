# Other PostgreSQL versions are an unsupported escape hatch for adoption

`postgresVersion` may name any PostgreSQL major version, not only 18, so that a database on an older server (such as 16) can be adopted. Every command then warns that the version is unsupported. Each target's server must run exactly that version, and the rehearsal server must still be 18. The point is to bring an existing schema under management and deploy it to PostgreSQL 18 targets from then on. We chose this over full support for other versions, because full support means every catalog query, the drift comparison and the test suite would have to cover each version. We also chose it over a bare switch that only skips the check, because that adopts nothing: a table with a `NOT NULL` column already reads differently on 16 than on 18.

## Consequences

- Migrations are still generated, ordered and rehearsed on PostgreSQL 18, so they may use SQL an older target can't run. Deploying to the older database after adoption may work, but nothing promises it.
- Only two catalog differences are smoothed over, and only where the target is older: before 17 a column's default statistics target reads `-1` instead of NULL, and before 18 a `NOT NULL` column has no `<table>_<column>_not_null` constraint. On servers before 17, the target's locale is read from `daticulocale`. Any other difference is refused like drift, which is fine for an escape hatch.
- This narrows spec story 96 ("refuse a server that isn't PostgreSQL 18"): the refusal now compares each target against `postgresVersion`, and the rehearsal server against 18.
