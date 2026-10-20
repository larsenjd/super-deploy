create function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function is_admin() returns boolean language sql stable as $$
  select exists (select 1 from admins where name = current_user)
$$;

create function customer_total(cid int) returns numeric language sql stable
begin atomic
  select coalesce(sum(amount), 0) from orders where customer_id = cid;
end;
