create table orders (id int primary key, amount moneyamount);
create view order_ids as select id from ordrs;
create function total() returns numeric language sql stable as $$ select sum(amount) from orders $$;
create function late() returns int language plpgsql as $$ begin return (select count(*) from not_checked_here); end $$;
