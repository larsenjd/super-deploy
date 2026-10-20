-- Both indexes are unnamed and PostgreSQL would call both t_a_idx; whichever
-- is created second becomes t_a_idx1. Independent statements, order-dependent names.
create index on t (a) where a > 0;
