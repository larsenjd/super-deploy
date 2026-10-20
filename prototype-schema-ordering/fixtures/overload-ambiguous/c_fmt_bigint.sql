create function fmt(x bigint) returns text language sql immutable return 'bigint:' || x::text;
