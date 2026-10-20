create view point_sums as
  select id, pair_sum(p) as s, (p).a as a from points;
