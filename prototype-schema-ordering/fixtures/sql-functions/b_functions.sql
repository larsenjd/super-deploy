create function default_amount() returns numeric language sql stable
  as $$ select coalesce(max(balance), 0) from accounts $$;

create function account_balance(aid int) returns numeric language sql stable
begin atomic
  select balance from accounts where id = aid;
end;

create function owner_ok(o text) returns boolean language sql immutable
  as $$ select o <> '' $$;

create function accounts_count() returns bigint language sql stable
  as $$ select count(*) from accounts $$;

-- PL/pgSQL: late-bound. Its table is created in z_late.sql and needs no ordering.
create function late_bound() returns bigint language plpgsql stable as $$
begin
  return (select count(*) from not_yet_created);
end $$;

create procedure credit(aid int, amt numeric) language sql
begin atomic
  update accounts set balance = balance + amt where id = aid;
end;

-- regclass literal: resolved to an OID at CREATE
create function ledger_oid() returns regclass language sql immutable
  return 'ledger'::regclass;
