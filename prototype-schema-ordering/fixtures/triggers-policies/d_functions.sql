create function is_editor(u text) returns boolean language sql stable
  as $$ select exists (select 1 from editors e where e.name = u) $$;

create function should_audit(t text) returns boolean language sql immutable
  return t is not null;

create function audit_doc() returns trigger language plpgsql as $$
begin
  insert into doc_audit (doc_id) values (new.id);
  return new;
end $$;
