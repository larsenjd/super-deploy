-- Reproduces why migration 4's original scripts failed on production:
-- a customer who signed up twice, typing their address in different case, and
-- a customer whose only address is in mixed case. Synthetic data only.
insert into customers (id, full_name, email) values
  (1, 'Ada Lovelace', 'ada@example.com'),
  (2, 'Ada Lovelace', 'Ada@Example.com'),
  (3, 'Charles Babbage', 'Charles@Example.com');

insert into orders (id, customer_id, total_cents) values
  (1, 1, 1250),
  (2, 2, 4999),
  (3, 3, 800);
