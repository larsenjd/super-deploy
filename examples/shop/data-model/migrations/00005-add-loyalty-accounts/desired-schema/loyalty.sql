-- One loyalty account per customer, earning a point per whole currency unit
-- spent.
create table loyalty_accounts (
  customer_id bigint primary key
    constraint loyalty_accounts_customer_id_fkey references customers (id),
  points integer not null default 0
    constraint loyalty_accounts_points_check check (points >= 0),
  joined_at timestamptz not null default now()
);
