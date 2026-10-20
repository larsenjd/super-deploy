// THROWAWAY spike (issue 01). One entry per supported object type in spec §4.1
// (plus a few dependency-ordering cases). Each entry has three states:
//   create: a -> b,  alter: b -> c,  drop: c -> a
// The SQL here only builds database states; it is not desired-schema-rule-checked.

export interface ObjectCase {
  name: string;
  a: string;
  b: string;
  c: string;
}

const T3 = `create table t (id int primary key, a int, b text);`;

export const CASES: ObjectCase[] = [
  {
    name: "table",
    a: ``,
    b: `create table t (id bigint primary key, name text not null default 'x', price numeric(10,2));`,
    c: `create table t (id bigint primary key, name varchar(200) not null, qty int not null default 1, extra jsonb);`,
  },
  {
    name: "generated column (stored)",
    a: `create table t (id int primary key, a int, b int);`,
    b: `create table t (id int primary key, a int, b int, total int generated always as (a + b) stored);`,
    c: `create table t (id int primary key, a int, b int, total int generated always as (a * b) stored);`,
  },
  {
    name: "generated column (virtual, PG18)",
    a: `create table t (id int primary key, a int, b int);`,
    b: `create table t (id int primary key, a int, b int, total int generated always as (a + b) virtual);`,
    c: `create table t (id int primary key, a int, b int, total int generated always as (a * b) virtual);`,
  },
  {
    name: "generated column stored -> virtual",
    a: `create table t (id int primary key, a int);`,
    b: `create table t (id int primary key, a int, g int generated always as (a * 2) stored);`,
    c: `create table t (id int primary key, a int, g int generated always as (a * 2) virtual);`,
  },
  {
    name: "primary key",
    a: `create table t (id int not null, code text not null);`,
    b: `create table t (id int not null, code text not null, constraint t_pk primary key (id));`,
    c: `create table t (id int not null, code text not null, constraint t_pk primary key (id, code));`,
  },
  {
    name: "foreign key",
    a: `create table parent (id int primary key, alt int unique); create table child (id int primary key, parent_id int);`,
    b: `create table parent (id int primary key, alt int unique);
        create table child (id int primary key, parent_id int constraint child_parent_fk references parent (id));`,
    c: `create table parent (id int primary key, alt int unique);
        create table child (id int primary key, parent_id int constraint child_parent_fk references parent (alt) on delete cascade deferrable initially deferred);`,
  },
  {
    name: "unique",
    a: `create table t (id int primary key, email text, tenant int);`,
    b: `create table t (id int primary key, email text, tenant int, constraint t_email_key unique (email));`,
    c: `create table t (id int primary key, email text, tenant int, constraint t_email_key unique nulls not distinct (tenant, email));`,
  },
  {
    name: "check",
    a: `create table t (id int primary key, qty int);`,
    b: `create table t (id int primary key, qty int constraint t_qty_check check (qty > 0));`,
    c: `create table t (id int primary key, qty int constraint t_qty_check check (qty >= 0 and qty < 1000));`,
  },
  {
    name: "check with BETWEEN (deparse fixed point)",
    a: `create table t (id int primary key, qty int);`,
    b: `create table t (id int primary key, qty int constraint t_qty_check check (qty between 1 and 10));`,
    c: `create table t (id int primary key, qty int constraint t_qty_check check (qty between 0 and 100 and (qty, id) > (0, 0)));`,
  },
  {
    name: "exclusion",
    a: `create table booking (id int primary key, room int, during tsrange);`,
    b: `create table booking (id int primary key, room int, during tsrange, constraint booking_no_overlap exclude using gist (during with &&));`,
    c: `create table booking (id int primary key, room int, during tsrange, constraint booking_no_overlap exclude using gist (during with &&) where (room is not null));`,
  },
  {
    name: "not null",
    a: `create table t (id int primary key, name text, code text);`,
    b: `create table t (id int primary key, name text not null, code text);`,
    c: `create table t (id int primary key, name text constraint name_required not null, code text not null);`,
  },
  {
    name: "index",
    a: T3,
    b: `${T3} create index t_a_idx on t (a);`,
    c: `${T3} create unique index t_a_idx on t (a, b) where b is not null; create index t_lower_b_idx on t (lower(b));`,
  },
  {
    name: "view",
    a: T3,
    b: `${T3} create view v as select id, a from t;`,
    c: `${T3} create view v as select id, a, b, a + 1 as a1 from t where id > 0;`,
  },
  {
    name: "view (column removed/retyped -> needs drop+create)",
    a: T3,
    b: `${T3} create view v as select id, a, b from t;`,
    c: `${T3} create view v as select id, b::varchar(10) as a from t;`,
  },
  {
    name: "materialized view",
    a: T3,
    b: `${T3} create materialized view mv as select a, count(*) as n from t group by a; create index mv_a_idx on mv (a);`,
    c: `${T3} create materialized view mv as select a, b, count(*) as n from t group by a, b with no data;`,
  },
  {
    name: "identity column",
    a: `create table t (id bigint not null, x text);`,
    b: `create table t (id bigint generated always as identity primary key, x text);`,
    c: `create table t (id bigint generated by default as identity (start with 100 increment by 5) primary key, x text);`,
  },
  {
    name: "function (plpgsql)",
    a: T3,
    b: `${T3} create function f(x int) returns int language plpgsql as $$ begin return x + 1; end $$;`,
    c: `${T3} create function f(x int) returns int language plpgsql stable security definer set search_path = public, pg_catalog
          as $$ begin return (select count(*) from t) + x; end $$;`,
  },
  {
    name: "function (sql, binds at create)",
    a: T3,
    b: `${T3} create function total_a() returns bigint language sql stable as $$ select sum(a) from t $$;`,
    c: `${T3} create function total_a() returns bigint language sql stable parallel safe as $$ select coalesce(sum(a), 0) from t where id > 0 $$;`,
  },
  {
    name: "function (BEGIN ATOMIC)",
    a: T3,
    b: `${T3} create function g(x int) returns int language sql immutable begin atomic select x + 1; end;`,
    c: `${T3} create function g(x int) returns int language sql stable begin atomic select x + (select count(*)::int from t); end;`,
  },
  {
    name: "function signature change",
    a: T3,
    b: `${T3} create function h(x int) returns int language sql immutable as $$ select x $$;`,
    c: `${T3} create function h(x int, y int default 0) returns bigint language sql immutable as $$ select (x + y)::bigint $$;`,
  },
  {
    name: "procedure",
    a: T3,
    b: `${T3} create procedure p(x int) language plpgsql as $$ begin insert into t (id, a) values (x, x); end $$;`,
    c: `${T3} create procedure p(x int) language plpgsql as $$ begin update t set a = x where id = x; end $$;`,
  },
  {
    name: "trigger",
    a: `${T3} create function tf() returns trigger language plpgsql as $$ begin new.b := upper(new.b); return new; end $$;`,
    b: `${T3} create function tf() returns trigger language plpgsql as $$ begin new.b := upper(new.b); return new; end $$;
        create trigger t_upper before insert on t for each row execute function tf();`,
    c: `${T3} create function tf() returns trigger language plpgsql as $$ begin new.b := upper(new.b); return new; end $$;
        create trigger t_upper before insert or update of b on t for each row when (new.b is not null) execute function tf();`,
  },
  {
    name: "domain",
    a: ``,
    b: `create domain positive_int as int constraint positive_int_check check (value > 0);
        create table t (id int primary key, n positive_int);`,
    c: `create domain positive_int as int not null default 1 constraint positive_int_check check (value > 0 and value < 1000000);
        create table t (id int primary key, n positive_int);`,
  },
  {
    name: "composite type",
    a: ``,
    b: `create type address as (street text, city text); create table t (id int primary key, addr address);`,
    c: `create type address as (street text, city text, zip varchar(10)); create table t (id int primary key, addr address);`,
  },
  {
    name: "row-level security + policies",
    a: `create table t (id int primary key, owner text);`,
    b: `create table t (id int primary key, owner text); alter table t enable row level security;
        create policy t_select on t for select using (owner = current_user);`,
    c: `create table t (id int primary key, owner text); alter table t enable row level security; alter table t force row level security;
        create policy t_select on t for all to prototype_reader using (owner = current_user) with check (owner = current_user);
        create policy t_admin on t as restrictive for delete using (current_user = 'admin');`,
  },
  {
    name: "comments",
    a: `${T3} create view v as select id from t; create function f() returns int language sql as $$ select 1 $$;`,
    b: `${T3} create view v as select id from t; create function f() returns int language sql as $$ select 1 $$;
        comment on table t is 'tee'; comment on column t.a is 'col a'; comment on view v is 'vee';
        comment on function f() is 'eff'; comment on constraint t_pkey on t is 'pk';`,
    c: `${T3} create view v as select id from t; create function f() returns int language sql as $$ select 1 $$;
        comment on table t is 'tee 2'; comment on column t.b is 'col b'; comment on function f() is 'eff 2';
        comment on index t_pkey is 'pk index';`,
  },
  {
    name: "grants",
    a: `${T3} create view v as select id from t; create function f() returns int language sql as $$ select 1 $$;`,
    b: `${T3} create view v as select id from t; create function f() returns int language sql as $$ select 1 $$;
        grant select on t to prototype_reader; grant select on v to prototype_reader;`,
    c: `${T3} create view v as select id from t; create function f() returns int language sql as $$ select 1 $$;
        grant select, insert on t to prototype_writer; grant select (id, a) on t to prototype_reader;
        revoke all on function f() from public; grant execute on function f() to prototype_reader;`,
  },
  {
    name: "dep: column type change under view, policy, index",
    a: `create table t (id int primary key, a int); create view v as select id, a from t;
        create index t_a_idx on t (a); alter table t enable row level security; create policy p on t using (a > 0);`,
    b: `create table t (id int primary key, a bigint); create view v as select id, a from t;
        create index t_a_idx on t (a); alter table t enable row level security; create policy p on t using (a > 0);`,
    c: `create table t (id int primary key, a numeric(12,2)); create view v as select id, a, a * 2 as a2 from t;
        create index t_a_idx on t (a); alter table t enable row level security; create policy p on t using (a > 0);`,
  },
  {
    name: "dep: circular foreign keys",
    a: ``,
    b: `create table customers (id int primary key, last_order_id int);
        create table orders (id int primary key, customer_id int not null references customers (id));
        alter table customers add constraint customers_last_order_fk foreign key (last_order_id) references orders (id);`,
    c: `create table customers (id int primary key, last_order_id int);
        create table orders (id int primary key, customer_id int not null references customers (id) on delete cascade);
        alter table customers add constraint customers_last_order_fk foreign key (last_order_id) references orders (id) deferrable initially deferred;`,
  },
  {
    name: "dep: view chain + sql function + domain",
    a: ``,
    b: `create domain amount as numeric(12,2) check (value >= 0);
        create table o (id int primary key, amt amount);
        create function o_total() returns numeric language sql stable as $$ select sum(amt) from o $$;
        create view v1 as select id, amt from o; create view v2 as select id, amt, o_total() as total from v1;`,
    c: `create domain amount as numeric(14,2) check (value >= 0);
        create table o (id int primary key, amt amount, note text);
        create function o_total() returns numeric language sql stable as $$ select coalesce(sum(amt), 0) from o $$;
        create view v1 as select id, amt, note from o; create view v2 as select id, amt, o_total() as total, note from v1;`,
  },
];
