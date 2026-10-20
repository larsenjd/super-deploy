create table orders (
  id int primary key,
  customer_id int not null references customers (id),
  amount money_amount not null,
  qty int not null default 1,
  double_qty int generated always as (qty * 2) virtual,
  updated_at timestamptz
);
create index orders_customer_idx on orders (customer_id);
grant select on orders to prototype_reader;
comment on table orders is 'customer orders';
