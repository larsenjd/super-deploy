create table points (
  id pos_int primary key,
  p pos_pair not null,
  history pair[] not null default '{}'
);
comment on column points.p is 'a strictly positive pair';
