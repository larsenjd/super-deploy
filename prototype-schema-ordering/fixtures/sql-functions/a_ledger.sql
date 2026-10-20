-- Defaults call LANGUAGE sql functions that read another table: the default
-- binds at CREATE, and check_function_bodies = on makes the function's body
-- need its table at CREATE too.
create table ledger (
  id int primary key,
  account_id int not null references accounts (id),
  amount numeric not null default default_amount(),
  balance_then numeric generated always as (amount * 2) stored,
  kind text not null default 'tx'::text
);
