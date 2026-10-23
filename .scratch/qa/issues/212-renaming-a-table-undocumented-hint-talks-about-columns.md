# 212: Renaming a table isn't documented, and `draft`'s hint for it talks about renamed columns

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** newproj
**Round:** 3

## What I did
Project with `managedSchema: "app"` and a deployed table:

```sql
create table accounts (
  id bigint generated always as identity primary key,
  name text not null,
  balance numeric(12,2) not null default 0,
  constraint accounts_balance_check check (balance >= 0)
);
```

Renamed it in the desired schema (`sed -i 's/accounts/customer_accounts/g'`), then, by analogy with README "Renaming a column":

```sh
pnpm exec super-deploy draft --name "rename accounts"   # warns: Table accounts is dropped with its data
echo "alter table accounts rename to customer_accounts;" > data-model/draft/pre-migration.sql
pnpm exec super-deploy draft
```

## Expected
The README says how to rename a table (it's as common as renaming a column), or `draft` says what else needs renaming.

## Actual
```
warning: The generated schema change doesn't produce the desired schema: the pre-migration script causes the difference, or pg-delta can't generate it (a column renamed in the pre-migration script needs its NOT NULL constraint renamed too: see the README, "Renaming a column")
  catalog: from the migrations: constraint: customer_accounts accounts_balance_not_null n NOT NULL balance ...
  catalog: from the migrations: constraint: customer_accounts accounts_id_not_null n NOT NULL id ...
  ...
```

and the schema change drops and re-adds the primary key (rebuilding its index) and the check constraint because their names still start with `accounts_`. What worked, after reading the catalog lines and the schema change, is renaming everything named after the table:

```sql
alter table accounts rename to customer_accounts;
alter table customer_accounts rename constraint accounts_id_not_null to customer_accounts_id_not_null;
alter table customer_accounts rename constraint accounts_name_not_null to customer_accounts_name_not_null;
alter table customer_accounts rename constraint accounts_balance_not_null to customer_accounts_balance_not_null;
alter table customer_accounts rename constraint accounts_balance_check to customer_accounts_balance_check;
alter table customer_accounts rename constraint accounts_pkey to customer_accounts_pkey;
alter sequence accounts_id_seq rename to customer_accounts_id_seq;
```

## Notes
- Suggest a "Renaming a table" paragraph next to "Renaming a column": rename the table, its NOT NULL constraints, its primary key (and other constraints and indexes named after it if the desired schema renames them), and its identity sequence.
- The hint in the warning could say "a table or column renamed in the pre-migration script needs its NOT NULL constraints renamed too".
