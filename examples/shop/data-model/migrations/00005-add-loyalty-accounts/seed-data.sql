-- Customers with and without orders, so the rehearsal runs the backfill over
-- both. Synthetic data only.
insert into customers (id, full_name, email) values
  (1, 'Ada Lovelace', 'ada@example.com'),
  (2, 'Grace Hopper', 'grace@example.com');

insert into orders (id, customer_id, total_cents) values
  (1, 1, 1250),
  (2, 1, 4999);
