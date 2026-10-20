create function pair_sum(x pos_pair) returns int language sql immutable
  return (x).a + (x).b;

create function make_pair(a pos_int, b pos_int) returns pos_pair language sql immutable
  return row(a, b)::pair::pos_pair;
