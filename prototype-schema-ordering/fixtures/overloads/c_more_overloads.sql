create function pick(x integer) returns text language sql immutable as $$ select 'integer' $$;
create function fmt(x integer) returns text language sql immutable return 'integer:' || x::text;
-- shadows pg_catalog.length(text): with search_path = public, pg_catalog the public one wins once it exists
create function length(x text) returns integer language sql immutable return 42;
