alter table orders enable row level security;
create policy orders_visible on orders
  using (is_admin() or customer_id = 42);
