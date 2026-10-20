create view which_pick as select pick(1) as picked;
create view which_len as select length('abc'::text) as l;

-- BEGIN ATOMIC body: binds at CREATE, like a view
create function uses_fmt() returns text language sql stable
begin atomic
  select fmt(2);
end;

-- column default: binds at CREATE
create table fmt_defaults (id int primary key, label text default fmt(3));
