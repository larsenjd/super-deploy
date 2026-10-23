# 245: Drift details print internal catalog fingerprints (`notnull=false identity= storage=x`, `pg_class`, `v`, `n`) instead of readable differences

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** fail
**Round:** 3

## What I did
Target `qa` (managed schema `app`) at its newest migration, `Drift: none`. As the deploy role, by hand:

```sql
alter table app.customers add column phone text;
drop index app.orders_customer_idx;
alter table app.notes alter column body drop not null;
alter table app.tags alter column label type varchar(200);
comment on table app.labels is 'hand comment';
create or replace view app.order_totals as ... where o.total > 0 ...;   -- one line added
```

```sh
pnpm exec super-deploy status --target qa
```

## Expected
README, "Drift": `status` "lists each difference, saying which side it is on". I expected each difference in terms a user wrote: `column app.customers.phone text` only on the target, `app.notes.body` is nullable on the target but NOT NULL in the migrations, `app.tags.label` is `varchar(200)` instead of `text`, a comment only on the target.

## Actual
```
  column phone of table app.customers:
    only on the target: column: customers.phone text notnull=false identity= generated= default=- collation="default" storage=x compression=- stattarget=- local=true
  column body of table app.notes:
    on the target: column: notes.body text notnull=false identity= generated= default=- collation="default" storage=x compression=- stattarget=- local=true
    expected by migrations: column: notes.body text notnull=true identity= generated= default=- collation="default" storage=x compression=- stattarget=- local=true
  constraint notes_body_not_null on table app.notes:
    missing from the target: constraint: notes notes_body_not_null n NOT NULL body deferrable=false deferred=false validated=true
  index app.orders_customer_idx:
    missing from the target: index: CREATE INDEX orders_customer_idx ON app.orders USING btree (customer_id) valid=true clustered=false replident=false
  table app.labels:
    on the target: comment: pg_class labels hand comment
  view app.order_totals:
    on the target: view: v order_totals  SELECT c.id,
          c.email,
    ...
```

- Each line is an internal fingerprint: empty `identity=` and `generated=`, `storage=x`, `stattarget=-`, `local=true`, constraint type letter `n`, relkind `v` before the view name, `pg_class` for a table comment.
- To spot a one-word difference (`notnull=false` vs `notnull=true`) you compare two 150-character lines by eye. For a changed view or function, both whole definitions are printed with nothing marking the line that differs.
- The table comment is listed under `table app.labels` as "on the target", with no "expected" line and without the "only on the target" wording used for the column.

## Notes
A whole table made by hand (`create table app.audit (id bigint generated always as identity primary key, what text not null)`) comes out as three drifted objects and nine fingerprint lines, including its identity sequence and primary-key index as separate objects:

```
  index app.audit_pkey:
    only on the target: index: CREATE UNIQUE INDEX audit_pkey ON app.audit USING btree (id) valid=true clustered=false replident=false
  sequence app.audit_id_seq:
    only on the target: relation: S audit_id_seq persistence=p options=- am=- replident=n inherits={} partkey=- bound=-
    only on the target: sequence: audit_id_seq bigint start=1 inc=1 min=1 max=9223372036854775807 cache=1 cycle=false
  table app.audit:
    only on the target: relation: r audit persistence=p options=- am=heap replident=d inherits={} partkey=- bound=-
    only on the target: column: audit.id bigint notnull=true identity=a generated= default=- collation=- storage=p compression=- stattarget=- local=true
    ...
```

Multi-line definitions (views, functions) are now indented consistently, and the closing summary line (`... (only on the target), ... (changed), ... (missing from the target)`) reads well. A per-line diff for changed definitions and plain attribute names (`nullable`, `type`) would make the detail lines as readable.
