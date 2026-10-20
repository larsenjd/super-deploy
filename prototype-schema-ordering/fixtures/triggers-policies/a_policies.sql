alter table docs enable row level security;
alter table docs force row level security;

create policy docs_owner on docs
  using (owner = current_user or is_editor(current_user));

create policy docs_team on docs for select
  using (exists (select 1 from teams t where t.id = docs.team_id and t.public));
