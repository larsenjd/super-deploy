create view order_totals as
  select c.id as customer_id, c.name, sum(o.amount) as total, count(*) as n
  from customers c join orders o on o.customer_id = c.id
  group by c.id, c.name;

create view big_customers as
  select customer_id, name, total from order_totals where total > 1000;
