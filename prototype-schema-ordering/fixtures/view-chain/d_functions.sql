create function double_it(x bigint) returns bigint language sql immutable as $$ select x * 2 $$;
