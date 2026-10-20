create view v3 as select k, n, d from v2 where n > 1;
create materialized view mv as select k, sum(n) as total from v1 group by k;
create unique index mv_k_idx on mv (k);
