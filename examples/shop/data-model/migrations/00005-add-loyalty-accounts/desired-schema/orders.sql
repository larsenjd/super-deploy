create table orders (
  id bigint primary key,
  customer_id bigint not null
    constraint orders_customer_id_fkey references customers (id),
  placed_at timestamptz not null default now(),
  total_cents integer not null
    constraint orders_total_cents_check check (total_cents >= 0)
);

create index orders_customer_id_idx on orders (customer_id);
