-- "base" is a CTE here, and also the name of a real table (z_base.sql).
-- The CTE shadows the table, so v2 must NOT depend on table base.
create view v2 as
  with base as (select k, n from v1)
  select k, n, double_it(n) as d from base;
