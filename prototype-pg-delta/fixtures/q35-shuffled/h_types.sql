create domain money_amount as numeric(12,2) check (value >= 0);
create type address as (street text, city text);
