create function order_count(c customers) returns bigint language sql stable
  as $$ select 0::bigint $$;

-- %TYPE is resolved at CREATE against the table (covered by the extractor)
create function name_of(n customers.name%type) returns text language sql immutable
  return upper(n);
