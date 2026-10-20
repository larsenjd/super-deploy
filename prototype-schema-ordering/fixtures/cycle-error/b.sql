create table b (id int primary key, a_id int references a (id));

-- Default calls a BEGIN ATOMIC function that reads the same table: also a cycle.
create table notes (id int primary key, label text default next_label());
create function next_label() returns text language sql stable
begin atomic
  select 'n' || count(*) from notes;
end;
