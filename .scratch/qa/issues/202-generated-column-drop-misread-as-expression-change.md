# 202: Dropping a generated column to retype its input is reported as a "generation expression" change, with advice that sends you in a loop

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** newproj
**Round:** 3

## What I did
Following the README, "Changing the type of a column a generated column uses":

```sh
node <repo>/packages/super-deploy/dist/cli.js init && git init && pnpm install
cat > data-model/desired-schema/a.sql <<'SQL'
create table a (
  id bigint generated always as identity primary key,
  price numeric(10,2) not null,
  qty integer not null,
  total numeric generated always as (price * qty) stored
);
SQL
pnpm exec super-deploy draft --name one && pnpm exec super-deploy finalize
sed -i 's/qty integer/qty bigint/' data-model/desired-schema/a.sql
pnpm exec super-deploy draft --name retype        # warns: drop "total" in the pre-migration script
echo 'alter table a drop column total;' > data-model/draft/pre-migration.sql
pnpm exec super-deploy draft
pnpm exec super-deploy rehearse
```

## Expected
The pre-migration drop is listed as a destructive drop that is re-added by the schema change (the README says "Dropping a column is destructive, so `finalize` asks you to acknowledge it"), described as what it is: dropped so `qty` can be retyped, values recomputed.

## Actual
`draft`, `rehearse` and `finalize` describe it as a generation-expression change, although the expression is unchanged, and advise an in-place statement that cannot work here:

```
destructive: data-model/draft/pre-migration.sql:1: public.a.total is dropped and re-added to change its generation expression: its values are computed again, but it moves to the end of the table and finalize needs the drop acknowledged. To avoid both, change it in place in the pre-migration script: ALTER TABLE "public"."a" ALTER COLUMN "total" SET EXPRESSION AS ((price * (qty)::numeric)) (finalize needs it acknowledged)
```

Following that advice (replacing the drop with the suggested `SET EXPRESSION` statement) brings back the original failure, whose advice is to drop the column again:

```
Error: data-model/draft/schema-change.sql:6: PostgreSQL refused it: cannot alter type of a column used by a generated column. ... Next: drop generated column "total" in the pre-migration script and run draft again ...
```

The same text appears in `finalize`'s acknowledgement question, so the reviewer is told the migration changes an expression it doesn't change.

## Notes
- README sections involved: "Changing the type of a column a generated column uses" and "Destructive changes" (the collation/generation-expression paragraph).
- Guess: the destructive classifier sees "generated column dropped, then added by the schema change" and assumes the expression-change case without checking whether the expression differs.
