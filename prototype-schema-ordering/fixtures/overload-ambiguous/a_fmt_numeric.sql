-- fmt(3) with an integer argument is AMBIGUOUS once both fmt(numeric) and
-- fmt(bigint) exist (both are implicit casts from integer). Path order creates
-- the table while only fmt(numeric) exists, so the default silently binds it.
create function fmt(x numeric) returns text language sql immutable return 'numeric:' || x::text;
