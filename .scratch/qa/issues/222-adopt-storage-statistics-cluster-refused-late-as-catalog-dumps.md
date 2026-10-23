# 222: Column STORAGE, COMPRESSION, statistics targets and CLUSTER are refused late, as raw catalog dumps

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** adopt
**Round:** 3

## What I did
The deploy role owns database `qa3_adopt_edge2`, and `managedSchema: "x"`:

```sql
create schema x;
create table x.t (id int primary key, body text compression pglz, n int, note text);
create index t_n_idx on x.t (n);
cluster x.t using t_n_idx;
alter table x.t alter column note set storage external;
alter table x.t alter column n set statistics 500;
-- plus some objects the README lists as refused, e.g.
create statistics x.t_stats on id, n from x.t;
alter table x.t set (autovacuum_enabled = false);
```

```sh
pnpm exec super-deploy init --adopt qa </dev/null
```

## Expected
The README's "Refused" list includes "column `STORAGE` and `COMPRESSION`
settings" under physical storage settings. So I expected them in the first
refusal, beside `CREATE STATISTICS` and the storage parameters, as
`[unsupported-object]`. Each should be named in plain words, with the
statement that resets it (`ALTER TABLE x.t ALTER COLUMN body SET COMPRESSION DEFAULT`,
`... SET STORAGE EXTENDED`, `... SET STATISTICS -1`, `ALTER TABLE x.t SET WITHOUT CLUSTER`).

## Actual
The first run lists only `CREATE STATISTICS` and the storage parameter. The
four column and index settings aren't mentioned. After I fixed those two, the
second run refused the rest as `not-reproduced`, with super-deploy's internal
catalog representation:

```
Target qa has 2 things V1 doesn't support:
  column body of table x.t
    not-reproduced: The desired schema generated from the target creates it differently: on the target: column: t.body text notnull=false identity= generated= default=- collation="default" storage=x compression=p stattarget=- local=true; generated: column: t.body text notnull=false identity= generated= default=- collation="default" storage=x compression=- stattarget=- local=true
  index x.t_n_idx
    not-reproduced: The desired schema generated from the target creates it differently: on the target: index: CREATE INDEX t_n_idx ON x.t USING btree (n) valid=true clustered=true replident=false; generated: index: CREATE INDEX t_n_idx ON x.t USING btree (n) valid=true clustered=false replident=false
```

`set storage external` and `set statistics 500` are refused the same way
(`storage=e` vs `storage=x`, `stattarget=500` vs `stattarget=-`). I saw those
two on other databases (`qa3_adopt_edge1`, `qa3_adopt_rich`). There too, they
appeared only after the first round's refusals were fixed. To fix them,
a user has to work out what `compression=p`, `storage=e`, `stattarget=500` and
`clustered=true` mean, and how to undo each. The closing line calls them
"things V1 doesn't support", but no rule is named.

## Notes
- Statistics targets and `CLUSTER` aren't in the README at all. Both are
  common on long-lived production databases (DBAs tune them), so an adopter
  will meet them.
- Related jargon: the view-column-comment refusal says "pg-delta doesn't
  generate them", and `draft`/`finalize` say "pg-delta can't generate the
  difference". The README calls it "the differ", and users never meet the
  name pg-delta otherwise.
