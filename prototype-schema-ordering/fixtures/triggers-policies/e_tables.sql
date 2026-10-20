create table docs (
  id int primary key,
  team_id int references teams (id),
  owner text not null,
  title text,
  constraint docs_title_len check (length(title) < 200)
);
create table doc_audit (doc_id int, at timestamptz not null default now());
