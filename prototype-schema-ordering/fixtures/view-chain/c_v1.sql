create view v1 as select k, count(*) as n from items group by k;
