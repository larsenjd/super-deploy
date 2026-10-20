-- Overloads and pg_catalog shadowing. Path order creates the views before
-- pick(integer) and before public.length(text) exist, so they bind to
-- pick(numeric) and pg_catalog.length; "all overloads first" binds the others.
create function pick(x numeric) returns text language sql immutable as $$ select 'numeric' $$;
create function fmt(x numeric) returns text language sql immutable return 'numeric:' || x::text;
