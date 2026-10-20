-- Backfill: open an account for every existing customer, crediting the
-- points their past orders earned. Customers created after this migration get
-- their account from the application.
insert into loyalty_accounts (customer_id, points)
  select c.id, coalesce(sum(o.total_cents), 0) / 100
  from customers c
  left join orders o on o.customer_id = c.id
  group by c.id;
