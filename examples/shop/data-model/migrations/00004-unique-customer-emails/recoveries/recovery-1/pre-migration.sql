-- Recovery 1 of migration 4. The original script only lower-cased addresses,
-- and production failed with: could not create unique index
-- "customers_email_key", because some customers had signed up twice with the
-- same address typed in different case.
--
-- For each address, keep the oldest account (the lowest id): move the other
-- accounts' orders to it, delete the other accounts, then lower-case what's
-- left.
create temp table duplicate_customers on commit drop as
  select c.id, keeper.id as keeper_id
  from customers c
  join (
    select lower(email) as email, min(id) as id
    from customers
    group by lower(email)
  ) keeper on keeper.email = lower(c.email)
  where c.id <> keeper.id;

update orders o
  set customer_id = d.keeper_id
  from duplicate_customers d
  where o.customer_id = d.id;

delete from customers c
  using duplicate_customers d
  where c.id = d.id;

update customers set email = lower(email) where email <> lower(email);
