// Desired-schema ordering fixtures, shared by the SQL-analysis seam (order,
// errors, file-name invariance) and the API seam (each accepted fixture loads
// into PostgreSQL 18 in both valid orders with the same catalog).
//
// Sources: every fixture of `prototype/schema-ordering` (25d5c18, including
// the two it borrows from `prototype/pg-delta`) and every case of
// `prototype/pg-topo-pg18` (7f91fd6) `cases.ts`, adapted to V1's rules
// (constraints and indexes named, VIRTUAL columns stored, no roles, grants
// or policies), plus cases for every modelled reference shape and every
// static refusal.

export interface OrderingFixture {
  readonly name: string;
  /** Desired-schema files by path relative to the desired-schema folder. */
  readonly files: Readonly<Record<string, string>>;
  /**
   * `[a, b]`: the statement containing `a` must load before the one containing
   * `b`, in the normal order and in the alternative order (which ignores kind
   * priority, so these are dependencies, not tie-breaks).
   */
  readonly before?: readonly (readonly [string, string])[];
  /** PostgreSQL refuses the (correctly ordered) schema with this message, on purpose. */
  readonly postgresRefuses?: string;
  /**
   * Rule ids the desired-schema rules refuse this (orderable) fixture with,
   * e.g. `COMMENT ON SCHEMA`, which the spec's allowlist leaves out. Ordering still
   * covers it; the API seam expects draft to refuse it before loading.
   */
  readonly refusedByRules?: readonly string[];
  /** Expected errors, in order; when present, the fixture is refused. */
  readonly errors?: readonly ExpectedError[];
}

export interface ExpectedError {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  /** Substrings the message must contain. */
  readonly message?: readonly string[];
}

/** One file per statement, written in a valid order: `case("x", [s1, s2])` -> x/01.sql, x/02.sql. */
function statements(...list: string[]): Record<string, string> {
  return Object.fromEntries(
    list.map((sql, index) => [
      `${String(index + 1).padStart(2, "0")}.sql`,
      `${sql};\n`,
    ]),
  );
}

export const orderingFixtures: readonly OrderingFixture[] = [
  // ---------------------------------------------------------------------------
  // prototype/pg-delta fixtures (borrowed by prototype/schema-ordering)
  {
    name: "q35-shuffled: file names in reverse dependency order",
    files: {
      "a_visible_orders.sql": `create view visible_orders as
  select id, amount from orders where is_admin() or customer_id = 42;
`,
      "b_views.sql": `create view order_totals as
  select c.id as customer_id, c.name, sum(o.amount) as total, count(*) as n
  from customers c join orders o on o.customer_id = c.id
  group by c.id, c.name;

create view big_customers as
  select customer_id, name, total from order_totals where total > 1000;
`,
      "c_triggers.sql": `create trigger orders_touch before update on orders
  for each row execute function touch_updated_at();
`,
      "d_functions.sql": `create function touch_updated_at() returns trigger language plpgsql as $$
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
`,
      "e_constraints/customers_last_order_fk.sql": `-- closes the customers <-> orders FK cycle
alter table customers add constraint customers_last_order_fk
  foreign key (last_order_id) references orders (id);
`,
      "f_orders.sql": `create table orders (
  id int primary key,
  customer_id int not null constraint orders_customer_fk references customers (id),
  amount money_amount not null,
  qty int not null default 1,
  double_qty int generated always as (qty * 2) stored,
  updated_at timestamptz
);
create index orders_customer_idx on orders (customer_id);
comment on table orders is 'customer orders';
`,
      "g_customers.sql": `create table customers (
  id int primary key,
  name text not null,
  last_order_id int,
  addr address
);
`,
      "h_types.sql": `create domain money_amount as numeric(12,2) constraint money_amount_nonnegative check (value >= 0);
create type address as (street text, city text);
`,
      "i_admins.sql": "create table admins (name text primary key);\n",
    },
    before: [
      ["create type address", "create table customers"],
      ["create domain money_amount", "create table orders"],
      ["create table customers", "create table orders"],
      ["create table orders", "alter table customers add constraint"],
      ["create table admins", "create function is_admin"],
      ["create function is_admin", "create view visible_orders"],
      ["create table orders", "create view order_totals"],
      ["create view order_totals", "create view big_customers"],
      ["create function touch_updated_at", "create trigger orders_touch"],
      ["create table orders", "create function customer_total"],
    ],
  },
  {
    name: "q35-overload-binding: a view waits for every overload it may bind",
    files: {
      "a_pick_numeric.sql":
        "create function pick(x numeric) returns text language sql immutable as $$ select 'numeric' $$;\n",
      "b_view.sql": "create view which_pick as select pick(1) as picked;\n",
      "c_pick_integer.sql":
        "create function pick(x integer) returns text language sql immutable as $$ select 'integer' $$;\n",
    },
    before: [
      ["create function pick(x numeric)", "create view which_pick"],
      ["create function pick(x integer)", "create view which_pick"],
    ],
  },

  // ---------------------------------------------------------------------------
  // prototype/schema-ordering fixtures
  {
    name: "cycle-error: an inline foreign-key cycle",
    files: {
      "a.sql":
        "-- Inline FK cycle: unsatisfiable without ALTER TABLE ... ADD CONSTRAINT.\ncreate table a (id int primary key, b_id int constraint a_b_fk references b (id));\n",
      "b.sql":
        "create table b (id int primary key, a_id int constraint b_a_fk references a (id));\n",
    },
    errors: [
      {
        file: "a.sql",
        line: 2,
        rule: "dependency-cycle",
        message: [
          "table a (data-model/desired-schema/a.sql:2) needs table b (data-model/desired-schema/b.sql:1) needs table a",
          "ALTER TABLE ... ADD CONSTRAINT",
        ],
      },
    ],
  },
  {
    name: "cycle-error: a default calling a BEGIN ATOMIC function that reads its own table",
    files: {
      "b.sql": `create table notes (id int primary key, label text default next_label());
create function next_label() returns text language sql stable
begin atomic
  select 'n' || count(*) from notes;
end;
`,
    },
    errors: [
      {
        file: "b.sql",
        line: 1,
        rule: "dependency-cycle",
        message: ["function next_label()", "table notes", "PL/pgSQL"],
      },
    ],
  },
  {
    name: "domain-composite: domains over composite types, arrays, RETURN bodies",
    files: {
      "a_views.sql":
        "create view point_sums as\n  select id, pair_sum(p) as s, (p).a as a from points;\n",
      "b_functions.sql": `create function pair_sum(x pos_pair) returns int language sql immutable
  return (x).a + (x).b;

create function make_pair(a pos_int, b pos_int) returns pos_pair language sql immutable
  return row(a, b)::pair::pos_pair;
`,
      "c_tables.sql": `create table points (
  id pos_int primary key,
  p pos_pair not null,
  history pair[] not null default '{}'
);
comment on column points.p is 'a strictly positive pair';
`,
      "d_domains.sql": `create domain pos_pair as pair
  constraint pos_pair_positive check ((value).a > 0 and (value).b > 0);
create domain pos_int as int constraint pos_int_positive check (value > 0);
comment on domain pos_pair is 'domain over a composite type';
`,
      "e_types.sql": "create type pair as (a int, b int);\n",
    },
    before: [
      ["create type pair", "create domain pos_pair"],
      ["create domain pos_pair", "create table points"],
      ["create domain pos_int", "create table points"],
      ["create domain pos_pair", "create function pair_sum"],
      ["create function pair_sum", "create view point_sums"],
      ["create table points", "create view point_sums"],
      ["create type pair", "create function make_pair"],
    ],
  },
  {
    name: "extraction-gap: functional notation is refused",
    files: {
      "a_view.sql":
        "-- c.order_count means order_count(c): invisible to ordering.\ncreate view customer_stats as select c.id, c.order_count from customers c;\n",
      "b_functions.sql": `create function order_count(c customers) returns bigint language sql stable
  as $$ select 0::bigint $$;
`,
      "c_customers.sql":
        "create table customers (id int primary key, name text not null);\n",
    },
    errors: [
      {
        file: "a_view.sql",
        line: 2,
        rule: "function-call-in-column-syntax",
        message: ["view customer_stats", "order_count(x)"],
      },
    ],
  },
  {
    name: "extraction-gap: %TYPE resolves against its table",
    files: {
      "b_functions.sql":
        "create function name_of(n customers.name%type) returns text language sql immutable\n  return upper(n);\n",
      "c_customers.sql":
        "create table customers (id int primary key, name text not null);\n",
    },
    before: [["create table customers", "create function name_of"]],
  },
  {
    name: "fk-index-choice: a foreign key over two unique keys is refused",
    files: {
      "a_child.sql": `create table child (
  id int primary key,
  parent_code text constraint child_parent_fk references parent (code)
);
`,
      "b_unique_index.sql":
        "create unique index parent_code_uidx on parent (code);\n",
      "c_unique_constraint.sql":
        "alter table parent add constraint parent_code_key unique (code);\n",
      "d_parent.sql":
        "create table parent (id int primary key, code text not null);\n",
    },
    errors: [
      {
        file: "a_child.sql",
        line: 1,
        rule: "foreign-key-ambiguous-unique-key",
        message: [
          "child_parent_fk",
          "parent (code)",
          "constraint parent_code_key, index parent_code_uidx",
        ],
      },
    ],
  },
  {
    name: "fk-index-choice: one unique key, a self-reference and an ALTER before its CREATE TABLE",
    files: {
      "a_child.sql":
        "create table child (\n  id int primary key,\n  parent_code text constraint child_parent_fk references parent (code)\n);\n",
      "c_unique_constraint.sql":
        "alter table parent add constraint parent_code_key unique (code);\n",
      "d_parent.sql":
        "create table parent (id int primary key, code text not null);\n",
      "e_tree.sql": `-- self-referencing FK, plus a node <-> leaf FK cycle closed by ALTER TABLE
alter table node add constraint node_best_leaf_fk foreign key (best_leaf_id) references leaf (id);
create table leaf (id int primary key, node_id int not null constraint leaf_node_fk references node (id));
create table node (id int primary key, parent_id int constraint node_parent_fk references node (id), best_leaf_id int);
`,
    },
    before: [
      [
        "alter table parent add constraint parent_code_key",
        "create table child",
      ],
      ["create table node", "create table leaf"],
      ["create table leaf", "alter table node add constraint"],
    ],
  },
  {
    name: "overload-ambiguous: a default waits for both candidate overloads",
    files: {
      "a_fmt_numeric.sql":
        "create function fmt(x numeric) returns text language sql immutable return 'numeric:' || x::text;\n",
      "b_table.sql":
        "create table fmt_defaults (id int primary key, label text default fmt(3));\n",
      "c_fmt_bigint.sql":
        "create function fmt(x bigint) returns text language sql immutable return 'bigint:' || x::text;\n",
    },
    // Both overloads exist first, so PostgreSQL refuses fmt(3) as ambiguous
    // rather than silently binding whichever came first.
    postgresRefuses: "function fmt(integer) is not unique",
    before: [
      ["fmt(x numeric)", "create table fmt_defaults"],
      ["fmt(x bigint)", "create table fmt_defaults"],
    ],
  },
  {
    name: "overloads: views, BEGIN ATOMIC and defaults wait for every overload, and for pg_catalog shadows",
    files: {
      "a_pick_numeric.sql": `create function pick(x numeric) returns text language sql immutable as $$ select 'numeric' $$;
create function fmt(x numeric) returns text language sql immutable return 'numeric:' || x::text;
`,
      "b_views.sql": `create view which_pick as select pick(1) as picked;
create view which_len as select length('abc'::text) as l;

-- BEGIN ATOMIC body: binds at CREATE, like a view
create function uses_fmt() returns text language sql stable
begin atomic
  select fmt(2);
end;

-- column default: binds at CREATE
create table fmt_defaults (id int primary key, label text default fmt(3));
`,
      "c_more_overloads.sql": `create function pick(x integer) returns text language sql immutable as $$ select 'integer' $$;
create function fmt(x integer) returns text language sql immutable return 'integer:' || x::text;
-- shadows pg_catalog.length(text)
create function length(x text) returns integer language sql immutable return 42;
`,
    },
    before: [
      ["pick(x integer)", "create view which_pick"],
      ["pick(x numeric)", "create view which_pick"],
      ["create function length", "create view which_len"],
      ["fmt(x integer)", "create function uses_fmt"],
      ["fmt(x numeric)", "create function uses_fmt"],
      ["fmt(x integer)", "create table fmt_defaults"],
    ],
  },
  {
    name: "sql-functions: defaults, BEGIN ATOMIC, a procedure, regclass and late-bound PL/pgSQL",
    files: {
      "a_ledger.sql": `create table ledger (
  id int primary key,
  account_id int not null constraint ledger_account_fk references accounts (id),
  amount numeric not null default default_amount(),
  balance_then numeric generated always as (amount * 2) stored,
  kind text not null default 'tx'::text
);
`,
      "b_functions.sql": `create function default_amount() returns numeric language sql stable
  as $$ select coalesce(max(balance), 0) from accounts $$;

create function account_balance(aid int) returns numeric language sql stable
begin atomic
  select balance from accounts where id = aid;
end;

create function owner_ok(o text) returns boolean language sql immutable
  as $$ select o <> '' $$;

create function accounts_count() returns bigint language sql stable
  as $$ select count(*) from accounts $$;

-- PL/pgSQL: late-bound. Its table needs no ordering.
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
`,
      "c_constraints.sql": `alter table accounts add constraint accounts_owner_known check (owner_ok(owner));
alter table accounts add constraint accounts_cap check (accounts_count() < 1000000);
`,
      "d_accounts.sql":
        "create table accounts (id int primary key, owner text not null, balance numeric not null default 0);\n",
      "z_late.sql": "create table not_yet_created (id int);\n",
    },
    before: [
      ["create table accounts", "create function default_amount"],
      ["create function default_amount", "create table ledger"],
      ["create table accounts", "create function account_balance"],
      ["create function owner_ok", "accounts_owner_known"],
      ["create function accounts_count", "accounts_cap"],
      ["create table accounts", "create procedure credit"],
      ["create table ledger", "create function ledger_oid"],
    ],
  },
  {
    name: "triggers: trigger WHEN and comments",
    files: {
      "b_triggers.sql": `create trigger docs_audit after insert or update on docs
  for each row when (should_audit(new.title))
  execute function audit_doc();
`,
      "c_comments.sql": `comment on column docs.title is 'Title';
comment on constraint docs_title_len on docs is 'length limit';
comment on trigger docs_audit on docs is 'audit trail';
comment on function is_editor(text) is 'is the user an editor';
comment on index docs_pkey is 'pk of docs';
`,
      "d_functions.sql": `create function is_editor(u text) returns boolean language sql stable
  as $$ select exists (select 1 from editors e where e.name = u) $$;

create function should_audit(t text) returns boolean language sql immutable
  return t is not null;

create function audit_doc() returns trigger language plpgsql as $$
begin
  insert into doc_audit (doc_id) values (new.id);
  return new;
end $$;
`,
      "e_tables.sql": `create table docs (
  id int primary key,
  team_id int constraint docs_team_fk references teams (id),
  owner text not null,
  title text,
  constraint docs_title_len check (length(title) < 200)
);
create table doc_audit (doc_id int, at timestamptz not null default now());
`,
      "f_teams.sql": `create table teams (id int primary key, public boolean not null default false);
create table editors (name text primary key);
`,
    },
    before: [
      ["create table teams", "create table docs"],
      ["create table editors", "create function is_editor"],
      ["create function should_audit", "create trigger docs_audit"],
      ["create function audit_doc", "create trigger docs_audit"],
      ["create trigger docs_audit", "comment on trigger docs_audit"],
    ],
  },
  {
    name: "unnamed-index: indexes without names are refused",
    files: {
      "a_partial.sql":
        "-- Both would be called t_a_idx; whichever came second, t_a_idx1.\ncreate index on t (a) where a > 0;\n",
      "b_plain.sql": "create index on t (a);\n",
      "c_table.sql": "create table t (id int primary key, a int);\n",
    },
    errors: [
      {
        file: "a_partial.sql",
        line: 2,
        rule: "unnamed-index",
        message: ["index on t"],
      },
      { file: "b_plain.sql", line: 1, rule: "unnamed-index" },
    ],
  },
  {
    name: "unresolved: typos are reported with file and line, PL/pgSQL references are not",
    files: {
      "a.sql": `create table orders (id int primary key, amount moneyamount);
create view order_ids as select id from ordrs;
create function total() returns numeric language sql stable as $$ select sum(amount) from orders $$;
create function late() returns int language plpgsql as $$ begin return (select count(*) from not_checked_here); end $$;
`,
    },
    errors: [
      {
        file: "a.sql",
        line: 1,
        rule: "unknown-reference",
        message: ["table orders references type moneyamount"],
      },
      {
        file: "a.sql",
        line: 2,
        rule: "unknown-reference",
        message: ["view order_ids references relation ordrs"],
      },
    ],
  },
  {
    name: "view-chain: views on views, a materialized view and a CTE named like a table",
    files: {
      "a_v3.sql": `create view v3 as select k, n, d from v2 where n > 1;
create materialized view mv as select k, sum(n) as total from v1 group by k;
create unique index mv_k_idx on mv (k);
`,
      "b_v2.sql": `-- "base" is a CTE here, and also the name of a real table (z_base.sql).
create view v2 as
  with base as (select k, n from v1)
  select k, n, double_it(n) as d from base;
`,
      "c_v1.sql":
        "create view v1 as select k, count(*) as n from items group by k;\n",
      "d_functions.sql":
        "create function double_it(x bigint) returns bigint language sql immutable as $$ select x * 2 $$;\n",
      "e_items.sql":
        "create table items (id int primary key, k text not null);\n",
      "z_base.sql": "create table base (k text, n bigint);\n",
    },
    before: [
      ["create table items", "create view v1"],
      ["create view v1", "create view v2"],
      ["create function double_it", "create view v2"],
      ["create view v2", "create view v3"],
      ["create view v1", "create materialized view mv"],
      ["create materialized view mv", "create unique index mv_k_idx"],
    ],
  },

  // ---------------------------------------------------------------------------
  // prototype/pg-topo-pg18 cases.ts (statements written in a valid order)
  {
    name: "C01 tables, primary key, unique, inline foreign keys",
    files: statements(
      "create table parent (id int primary key, code text not null constraint parent_code_key unique)",
      "create table child (id int primary key, parent_id int not null constraint child_parent_fk references parent (id), code text constraint child_code_fk references parent (code))",
    ),
    before: [["create table parent", "create table child"]],
  },
  {
    name: "C02 circular foreign keys closed with ALTER TABLE ... ADD CONSTRAINT",
    files: statements(
      "create table a (id int primary key, b_id int)",
      "create table b (id int primary key, a_id int constraint b_a_fk references a (id))",
      "alter table a add constraint a_b_fk foreign key (b_id) references b (id)",
    ),
    before: [
      ["create table a", "create table b"],
      ["create table b", "alter table a add constraint"],
    ],
  },
  {
    name: "C03 a check calling a function, a named unique and an exclusion constraint",
    files: statements(
      "create function is_positive(x int) returns boolean language sql immutable return x > 0",
      "create table booking (id int primary key, n int constraint booking_n_chk check (is_positive(n)), during tstzrange, constraint booking_no_overlap exclude using gist (during with &&), constraint booking_n_uq unique (n))",
    ),
    before: [["create function is_positive", "create table booking"]],
  },
  {
    name: "C04a NOT NULL: unnamed and named column constraints",
    files: statements(
      "create table nn1 (a int not null, b int constraint nn1_b_nn not null)",
      "create view nn1_v as select a, b from nn1",
    ),
    before: [["create table nn1", "create view nn1_v"]],
  },
  {
    name: "C04b NOT NULL as a named table constraint (PG18)",
    files: statements(
      "create table nn2 (a int, constraint nn2_a_nn not null a)",
      "create view nn2_v as select a from nn2",
    ),
    before: [["create table nn2", "create view nn2_v"]],
  },
  {
    name: "C04c NOT NULL added with ALTER TABLE, and a comment on it (PG18)",
    files: statements(
      "create table nn3 (a int)",
      "alter table nn3 add constraint nn3_a_nn not null a",
      "comment on constraint nn3_a_nn on nn3 is 'named not null'",
    ),
    before: [
      ["create table nn3", "alter table nn3"],
      ["alter table nn3", "comment on constraint"],
    ],
  },
  {
    name: "C05 a stored generated column calling a function",
    files: statements(
      "create function dbl(x int) returns int language sql immutable return x * 2",
      "create table g (a int, b int generated always as (dbl(a)) stored)",
    ),
    before: [["create function dbl", "create table g"]],
  },
  {
    name: "C07 identity columns",
    files: statements(
      "create table ident (id bigint generated always as identity primary key, x int generated by default as identity (start with 10))",
      "create view ident_v as select id, x from ident",
    ),
    before: [["create table ident", "create view ident_v"]],
  },
  {
    name: "C08 unique expression index with a function, partial index, INCLUDE",
    files: statements(
      "create function norm(t text) returns text language sql immutable return lower(t)",
      "create table ix (id int, email text, active boolean)",
      "create unique index ix_email_uidx on ix (norm(email)) where active",
      "create index ix_id_idx on ix (id) include (email)",
    ),
    before: [
      ["create function norm", "create unique index ix_email_uidx"],
      ["create table ix", "create index ix_id_idx"],
    ],
  },
  {
    name: "C09 view chain, security_invoker view, materialized view with an index",
    files: statements(
      "create table base (id int primary key, v int)",
      "create view v1 as select id, v from base",
      "create view v2 with (security_invoker = true) as select id, v * 2 as v2 from v1",
      "create materialized view mv as select id, v2 from v2",
      "create unique index mv_id_uidx on mv (id)",
    ),
    before: [
      ["create view v1", "create view v2"],
      ["create view v2", "create materialized view mv"],
      ["create materialized view mv", "create unique index"],
    ],
  },
  {
    name: "C10a LANGUAGE sql string body reading a table",
    files: statements(
      "create table acct (id int primary key, bal numeric)",
      "create function total_bal() returns numeric language sql stable as $$ select sum(bal) from acct $$",
    ),
    before: [["create table acct", "create function total_bal"]],
  },
  {
    name: "C10b LANGUAGE sql string body reading a view",
    files: statements(
      "create table acct2 (id int primary key, bal numeric)",
      "create view acct2_v as select id, bal from acct2",
      "create function acct2_total() returns numeric language sql stable as $$ select sum(bal) from acct2_v $$",
    ),
    before: [["create view acct2_v", "create function acct2_total"]],
  },
  {
    name: "C10c LANGUAGE sql string body reading a view qualified with the managed schema",
    files: statements(
      "create table acct3 (id int primary key, bal numeric)",
      "create view acct3_v as select id, bal from acct3",
      "create function acct3_total() returns numeric language sql stable as $$ select sum(bal) from public.acct3_v $$",
    ),
    before: [["create view acct3_v", "create function acct3_total"]],
  },
  {
    name: "C11 BEGIN ATOMIC body reading a view; RETURN body calling a function",
    files: statements(
      "create table acct4 (id int primary key, bal numeric)",
      "create view acct4_v as select id, bal from acct4",
      "create function acct4_count() returns bigint language sql begin atomic select count(*) from acct4_v; end",
      "create function acct4_count_plus() returns bigint language sql return acct4_count() + 1",
    ),
    before: [
      ["create view acct4_v", "create function acct4_count()"],
      ["create function acct4_count()", "create function acct4_count_plus"],
    ],
  },
  {
    name: "C12 SETOF a row type, RETURNS TABLE, an argument default calling a function",
    files: statements(
      "create table item (id int, price numeric)",
      "create function base_price() returns numeric language sql immutable return 10",
      "create function items_over(p numeric default base_price()) returns setof item language sql stable begin atomic select * from item where price > p; end",
      "create function item_summary() returns table (n bigint, s numeric) language sql begin atomic select count(*), sum(price) from item; end",
    ),
    before: [
      ["create function base_price", "create function items_over"],
      ["create table item", "create function items_over"],
      ["create table item", "create function item_summary"],
    ],
  },
  {
    name: "C13 procedures: BEGIN ATOMIC binds, PL/pgSQL doesn't",
    files: statements(
      "create table item2 (id int, price numeric)",
      "create procedure bump(p_id int) language sql begin atomic update item2 set price = price + 1 where id = p_id; end",
      "create procedure bump_all() language plpgsql as $$ begin update item2 set price = price + 1; end $$",
    ),
    before: [["create table item2", "create procedure bump(p_id"]],
  },
  {
    name: "C14 PL/pgSQL trigger function and a trigger WHEN calling a SQL function",
    files: statements(
      "create table doc (id int, body text, updated_at timestamptz)",
      "create function touch() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$",
      "create function changed(a text, b text) returns boolean language sql immutable return a is distinct from b",
      "create trigger doc_touch before update on doc for each row when (changed(old.body, new.body)) execute function touch()",
    ),
    before: [
      ["create function changed", "create trigger doc_touch"],
      ["create function touch", "create trigger doc_touch"],
      ["create table doc", "create trigger doc_touch"],
    ],
  },
  {
    name: "C15 domains over domains, a composite type with a domain attribute, arrays",
    files: statements(
      "create function valid_email(t text) returns boolean language sql immutable return t like '%@%'",
      "create domain email as text constraint email_valid check (valid_email(value))",
      "create domain work_email as email constraint work_email_com check (value like '%.com')",
      "create type contact as (name text, mail work_email)",
      "create table person (id int, c contact, cs contact[], e email)",
      "create function contact_name(c contact) returns text language sql immutable return (c).name",
    ),
    before: [
      ["create function valid_email", "create domain email"],
      ["create domain email", "create domain work_email"],
      ["create domain work_email", "create type contact"],
      ["create type contact", "create table person"],
      ["create type contact", "create function contact_name"],
    ],
  },
  {
    name: "C17 comments on every supported kind",
    files: statements(
      "create function cm_fn(x int) returns int language sql immutable return x",
      "create domain cm_dom as int constraint cm_dom_positive check (value > 0)",
      "create type cm_type as (a int)",
      "create table cm (id int constraint cm_pk primary key, a cm_dom)",
      "create view cm_v as select id from cm",
      "create materialized view cm_mv as select id from cm",
      "create index cm_a_idx on cm (a)",
      "create function cm_trg() returns trigger language plpgsql as $$ begin return new; end $$",
      "create trigger cm_t before insert on cm for each row execute function cm_trg()",
      "create procedure cm_proc() language sql begin atomic select 1; end",
      "comment on table cm is 't'",
      "comment on column cm.a is 'c'",
      "comment on view cm_v is 'v'",
      "comment on materialized view cm_mv is 'mv'",
      "comment on function cm_fn(int) is 'f'",
      "comment on procedure cm_proc() is 'p'",
      "comment on constraint cm_pk on cm is 'pk'",
      "comment on index cm_a_idx is 'i'",
      "comment on trigger cm_t on cm is 'tr'",
      "comment on type cm_type is 'ty'",
      "comment on domain cm_dom is 'd'",
      "comment on constraint cm_dom_positive on domain cm_dom is 'dc'",
    ),
    before: [
      ["create index cm_a_idx", "comment on index cm_a_idx"],
      ["create trigger cm_t", "comment on trigger cm_t"],
    ],
  },
  {
    // pg-delta doesn't generate them (QA 127), so no migration would.
    name: "C17b comments on view and materialized-view columns are refused",
    files: {
      "a.sql": `create table cv (id int constraint cv_pk primary key, v text);
create view cv_v as select id, v from cv;
create materialized view cv_mv as select id from cv;
comment on column cv.v is 'table column';
comment on view cv_v is 'the view';
`,
      "b.sql": `comment on column cv_v.v is 'view column';
comment on column public.cv_mv.id is 'materialized-view column';
`,
    },
    errors: [
      {
        file: "b.sql",
        line: 1,
        rule: "unsupported-object",
        message: [
          "Comments on view and materialized-view columns are not supported in V1",
          "view cv_v",
        ],
      },
      {
        file: "b.sql",
        line: 2,
        rule: "unsupported-object",
        message: ["materialized view cv_mv"],
      },
    ],
  },
  {
    name: "C19 CREATE EXTENSION plpgsql and a PL/pgSQL function",
    files: statements(
      "create extension if not exists plpgsql",
      "create function pl_one() returns int language plpgsql as $$ begin return 1; end $$",
    ),
    before: [["create extension", "create function pl_one"]],
  },
  {
    name: "C20a temporal primary key WITHOUT OVERLAPS (PG18)",
    files: statements(
      "create table room (id int4range, during tstzrange, constraint room_pk primary key (id, during without overlaps))",
      "create view room_v as select id from room",
    ),
    before: [["create table room", "create view room_v"]],
  },
  {
    name: "C20b temporal foreign key with PERIOD (PG18)",
    files: statements(
      "create table room2 (id int4range, during tstzrange, constraint room2_pk primary key (id, during without overlaps))",
      "create table stay (room_id int4range, during tstzrange, constraint stay_fk foreign key (room_id, period during) references room2 (id, period during))",
    ),
    before: [["create table room2", "create table stay"]],
  },
  {
    name: "C20c temporal unique WITHOUT OVERLAPS (PG18)",
    files: statements(
      "create table slot (k int4range, during daterange, constraint slot_uq unique (k, during without overlaps))",
      "create view slot_v as select k from slot",
    ),
    before: [["create table slot", "create view slot_v"]],
  },
  {
    name: "C22a RETURNING old/new in a BEGIN ATOMIC body (PG18)",
    files: statements(
      "create table ctr (id int primary key, n int)",
      "create function bump_ctr(p int) returns table (old_n int, new_n int) language sql begin atomic update ctr set n = n + 1 where id = p returning old.n, new.n; end",
    ),
    before: [["create table ctr", "create function bump_ctr"]],
  },
  {
    name: "C22b RETURNING WITH (OLD AS o, NEW AS nw) in a string body (PG18)",
    files: statements(
      "create table ctr2 (id int primary key, n int)",
      "create function bump_ctr2(p int) returns table (old_n int, new_n int) language sql as $$ update ctr2 set n = n + 1 where id = p returning with (old as o, new as nw) o.n, nw.n $$",
    ),
    before: [["create table ctr2", "create function bump_ctr2"]],
  },
  {
    name: "C23 PG18 built-ins uuidv7() and casefold()",
    files: statements(
      "create table ev (id uuid default uuidv7() primary key, name text constraint ev_name_check check (casefold(name) <> ''))",
      "create view ev_v as select id, name from ev",
    ),
    before: [["create table ev", "create view ev_v"]],
  },
  {
    name: "C24 NOT NULL ... NO INHERIT and CHECK ... NO INHERIT (PG18)",
    files: statements(
      "create table ni (a int not null no inherit, b int, constraint ni_b_chk check (b > 0) no inherit)",
      "create view ni_v as select a, b from ni",
    ),
    before: [["create table ni", "create view ni_v"]],
  },
  {
    name: "C25 a regclass literal default and a %TYPE argument",
    files: statements(
      "create table rc (id int primary key, n text)",
      "create function rc_name(x rc.n%type) returns text language sql immutable return x",
      "create table rc2 (id int, src regclass default 'rc'::regclass)",
    ),
    before: [
      ["create table rc ", "create function rc_name"],
      ["create table rc ", "create table rc2"],
    ],
  },
  {
    name: "C26 functional notation in a view is refused",
    files: statements(
      "create table cust (id int primary key)",
      "create function order_count(c cust) returns bigint language sql stable return 0",
      "create view cust_v as select c.id, c.order_count from cust c",
    ),
    errors: [
      { file: "03.sql", line: 1, rule: "function-call-in-column-syntax" },
    ],
  },
  {
    name: "C27 a CTE named like a real table",
    files: statements(
      "create table src (id int)",
      "create table other (id int)",
      "create view cte_v as with other as (select id from src) select id from other",
    ),
    before: [["create table src", "create view cte_v"]],
  },
  // ---------------------------------------------------------------------------
  // More reference shapes
  {
    name: "nextval() on another table's identity sequence",
    files: {
      "a.sql":
        "create table mirror (id bigint primary key default nextval('src_id_seq'));\n",
      "b.sql":
        "create table src (id bigint generated by default as identity primary key);\n",
    },
    before: [["create table src", "create table mirror"]],
  },
  {
    name: "regproc literal in a default",
    files: {
      "a.sql":
        "create table hooks (id int primary key, fn regproc not null default 'audit_hook'::regproc);\n",
      "b.sql":
        "create function audit_hook() returns int language sql immutable return 1;\n",
    },
    before: [["create function audit_hook", "create table hooks"]],
  },
  {
    name: "a composite type attribute of a table's row type",
    files: {
      "a.sql":
        "create type snapshot as (taken_at timestamptz, row_data customers);\n",
      "b.sql": "create table customers (id int primary key, name text);\n",
    },
    before: [["create table customers", "create type snapshot"]],
  },
  {
    name: "a column typed with another table's row type and an array of it",
    files: {
      "a.sql":
        "create table archive (id int primary key, latest customers, history customers[]);\n",
      "b.sql": "create table customers (id int primary key, name text);\n",
    },
    before: [["create table customers", "create table archive"]],
  },
  {
    name: "a view casting to a domain",
    files: {
      "a.sql":
        "create view priced as select id, price::money_amount as price from items;\n",
      "b.sql":
        "create table items (id int primary key, price numeric);\ncreate domain money_amount as numeric(12,2);\n",
    },
    before: [
      ["create domain money_amount", "create view priced"],
      ["create table items", "create view priced"],
    ],
  },
  {
    name: "a domain default calling a function",
    files: {
      "a.sql": "create domain ticket_code as text default new_code();\n",
      "b.sql":
        "create function new_code() returns text language sql volatile return md5(random()::text);\n",
    },
    before: [["create function new_code", "create domain ticket_code"]],
  },
  {
    name: "an argument default calling a function, with a domain argument type",
    files: {
      "a.sql":
        "create function greet(who person_name default default_name()) returns text language sql immutable return 'hi ' || who;\n",
      "b.sql":
        "create domain person_name as text;\ncreate function default_name() returns person_name language sql immutable return 'you'::person_name;\n",
    },
    before: [
      ["create domain person_name", "create function default_name"],
      ["create function default_name", "create function greet"],
    ],
  },
  {
    name: "a recursive view",
    files: {
      "a.sql":
        "create recursive view ancestry (id, parent_id) as select id, parent_id from nodes union all select a.id, n.parent_id from ancestry a join nodes n on n.id = a.parent_id;\n",
      "b.sql": "create table nodes (id int primary key, parent_id int);\n",
    },
    before: [["create table nodes", "create recursive view"]],
  },
  {
    // Populating a materialized view runs with search_path = pg_catalog, so
    // the function body qualifies its table.
    name: "a materialized view calling a function over a view",
    files: {
      "a.sql":
        "create materialized view daily as select day, total_of(day) as total from days;\n",
      "b.sql":
        "create view days as select distinct created_at::date as day from orders;\ncreate function total_of(d date) returns numeric language sql stable as $$ select coalesce(sum(amount), 0) from public.orders where created_at::date = d $$;\n",
      "c.sql":
        "create table orders (id int primary key, amount numeric, created_at timestamptz);\n",
    },
    before: [
      ["create table orders", "create view days"],
      ["create table orders", "create function total_of"],
      ["create view days", "create materialized view daily"],
      ["create function total_of", "create materialized view daily"],
    ],
  },
  {
    name: "a LANGUAGE sql function returning SETOF a view, with several statements",
    files: {
      "a.sql":
        "create function recent() returns setof recent_orders language sql volatile as $$\n  insert into audit_log (what) values ('recent');\n  select id, amount from recent_orders;\n$$;\n",
      "b.sql":
        "create view recent_orders as select id, amount from orders;\ncreate table audit_log (what text);\ncreate table orders (id int primary key, amount numeric);\n",
    },
    before: [
      ["create view recent_orders", "create function recent"],
      ["create table audit_log", "create function recent"],
    ],
  },
  {
    name: "CALL inside a LANGUAGE sql procedure body",
    files: {
      "a.sql":
        "create procedure outer_proc() language sql as $$ call inner_proc() $$;\n",
      "b.sql":
        "create procedure inner_proc() language sql begin atomic insert into log (n) values (1); end;\ncreate table log (n int);\n",
    },
    before: [
      ["create table log", "create procedure inner_proc"],
      ["create procedure inner_proc", "create procedure outer_proc"],
    ],
  },
  {
    name: "overloads of different arity are all waited for",
    files: {
      "a.sql":
        "create view sums as select add_up(1) as one, add_up(1, 2) as two;\n",
      "b.sql":
        "create function add_up(a int) returns int language sql immutable return a;\ncreate function add_up(a int, b int) returns int language sql immutable return a + b;\n",
    },
    before: [
      ["add_up(a int) returns", "create view sums"],
      ["add_up(a int, b int)", "create view sums"],
    ],
  },
  {
    name: "a trigger on a view and two triggers sharing a function",
    files: {
      "a.sql": `create trigger items_v_insert instead of insert on items_v
  for each row execute function items_v_write();
create trigger items_touch before update on items
  for each row execute function touch();
create trigger items_touch_again before insert on items
  for each row execute function touch();
`,
      "b.sql": `create function items_v_write() returns trigger language plpgsql as $$ begin insert into items (id) values (new.id); return new; end $$;
create function touch() returns trigger language plpgsql as $$ begin return new; end $$;
create view items_v as select id from items;
create table items (id int primary key);
`,
    },
    before: [
      ["create view items_v", "create trigger items_v_insert"],
      ["create function items_v_write", "create trigger items_v_insert"],
      ["create function touch", "create trigger items_touch "],
      ["create function touch", "create trigger items_touch_again"],
    ],
  },
  {
    name: "comments on generated names: the primary key, its index, a NOT NULL and an identity sequence",
    files: {
      "a.sql": `comment on index accounts_pkey is 'pk index';
comment on constraint accounts_pkey on accounts is 'pk';
comment on constraint accounts_owner_not_null on accounts is 'owner required';
comment on sequence accounts_id_seq is 'ids';
`,
      "b.sql":
        "create table accounts (id int generated always as identity primary key, owner text not null);\n",
    },
    before: [["create table accounts", "comment on index accounts_pkey"]],
  },
  {
    // Expected names read back from PostgreSQL 18.4.
    name: "generated names shortened to 63 bytes the way PostgreSQL does",
    files: {
      "a.sql": `comment on index a_table_name_that_is_exactly_sixty_characters_long_xxxxxxx_pkey is 'pk';
comment on constraint a_table_name_that_is_exactly_sixty_characters_long__id_not_null on a_table_name_that_is_exactly_sixty_characters_long_xxxxxxxxxxx is 'pk column';
comment on constraint "a_table_name_that_is_exactl_ünïcödé_column_name_th_not_null" on a_table_name_that_is_exactly_sixty_characters_long_xxxxxxxxxxx is 'multi-byte';
`,
      "b.sql":
        "create table a_table_name_that_is_exactly_sixty_characters_long_xxxxxxxxxxx (id int primary key, ünïcödé_column_name_that_is_long_enough_to_need_clipping_yes int not null);\n",
    },
    before: [["create table", "comment on index"]],
  },
  {
    name: "an identity sequence with an explicit name",
    files: {
      "a.sql": "comment on sequence ticket_numbers is 'ticket numbers';\n",
      "b.sql":
        "create table tickets (id bigint generated always as identity (sequence name ticket_numbers) primary key);\n",
    },
    before: [["create table tickets", "comment on sequence ticket_numbers"]],
  },
  {
    name: "a foreign key without columns uses the primary key even with another unique key",
    files: {
      "a.sql":
        "create table child (id int primary key, parent_id int constraint child_parent_fk references parent);\n",
      "b.sql":
        "create table parent (id int primary key, constraint parent_id_key unique (id));\n",
    },
    before: [["create table parent", "create table child"]],
  },
  {
    name: "a foreign key waits for a unique key added later by ALTER TABLE",
    files: {
      "a.sql":
        "alter table child add constraint child_parent_code_fk foreign key (parent_code) references parent (code);\n",
      "b.sql":
        "create unique index parent_code_uidx on parent (code);\ncreate table parent (id int primary key, code text not null);\ncreate table child (id int primary key, parent_code text);\n",
    },
    before: [
      ["create unique index parent_code_uidx", "alter table child"],
      ["create table child", "alter table child"],
    ],
  },
  {
    name: "a check added with ALTER TABLE calling a function that reads its table",
    files: {
      "a.sql":
        "alter table seats add constraint seats_capacity check (seats_taken() <= 100);\n",
      "b.sql":
        "create function seats_taken() returns bigint language sql stable as $$ select count(*) from seats $$;\ncreate table seats (id int primary key);\n",
    },
    before: [
      ["create table seats", "create function seats_taken"],
      ["create function seats_taken", "alter table seats"],
    ],
  },
  {
    name: "an index expression calling a user function",
    files: {
      "a.sql": "create index people_name_idx on people (normalise(name));\n",
      "b.sql":
        "create function normalise(t text) returns text language sql immutable return lower(trim(t));\ncreate table people (id int primary key, name text);\n",
    },
    before: [
      ["create function normalise", "create index people_name_idx"],
      ["create table people", "create index people_name_idx"],
    ],
  },
  {
    name: "quoted and Unicode identifiers",
    files: {
      "a.sql":
        'create view "Kunden_Übersicht" as select "Nr", größe from "Kunden";\n',
      "b.sql": 'create table "Kunden" ("Nr" int primary key, größe int);\n',
    },
    before: [['create table "Kunden"', 'create view "Kunden_Übersicht"']],
  },
  {
    name: "a qualified pg_catalog call and a pg_catalog table need nothing",
    files: {
      "a.sql":
        "create view catalog_tables as select relname, pg_catalog.upper(relname) as up from pg_class;\n",
    },
  },
  {
    name: "independent statements tie-break by kind, then identity",
    files: {
      "z.sql":
        "create table alpha (id int);\ncreate view beta as select 1 as one;\n",
      "a.sql":
        "create table gamma (id int);\ncreate function delta() returns int language sql immutable return 1;\n",
    },
    before: [],
  },
  {
    name: "a schema comment runs last",
    files: {
      "a.sql": "comment on schema public is 'managed';\n",
      "b.sql": "create table things (id int primary key);\n",
    },
    before: [["create table things", "comment on schema public"]],
    refusedByRules: ["desired-schema-statement"],
  },
  // ---------------------------------------------------------------------------
  // Static refusals and errors
  {
    name: "unnamed unique, check, foreign key and exclusion constraints are refused, each at its own line",
    files: {
      "a.sql": `create table parent (id int primary key);
create table t (
  a int unique,
  b int check (b > 0),
  c int references parent (id),
  d tstzrange,
  check (a < b),
  exclude using gist (d with &&)
);
`,
    },
    errors: [
      {
        file: "a.sql",
        line: 3,
        rule: "unnamed-constraint",
        message: ["unique constraint on t.a"],
      },
      {
        file: "a.sql",
        line: 4,
        rule: "unnamed-constraint",
        message: ["check constraint on t.b"],
      },
      {
        file: "a.sql",
        line: 5,
        rule: "unnamed-constraint",
        message: ["foreign key constraint on t.c"],
      },
      {
        file: "a.sql",
        line: 7,
        rule: "unnamed-constraint",
        message: ["check constraint on table t"],
      },
      {
        file: "a.sql",
        line: 8,
        rule: "unnamed-constraint",
        message: ["exclusion constraint on table t"],
      },
    ],
  },
  {
    name: "an unnamed constraint added with ALTER TABLE is refused",
    files: {
      "a.sql": "create table t (a int);\nalter table t add unique (a);\n",
    },
    errors: [
      {
        file: "a.sql",
        line: 2,
        rule: "unnamed-constraint",
        message: ["unique constraint on table t"],
      },
    ],
  },
  {
    name: "an unnamed domain check is refused at its own line",
    files: { "a.sql": "create domain positive as int\n  check (value > 0);\n" },
    errors: [
      {
        file: "a.sql",
        line: 2,
        rule: "unnamed-constraint",
        message: ["domain positive"],
      },
    ],
  },
  {
    name: "a table created twice",
    files: {
      "a.sql": "create table customers (id int primary key);\n",
      "b/c.sql": "\ncreate table customers (id bigint primary key);\n",
    },
    errors: [
      {
        file: "b/c.sql",
        line: 2,
        rule: "duplicate-object",
        message: [
          "Relation customers is created more than once",
          "table customers (data-model/desired-schema/a.sql:1)",
        ],
      },
    ],
  },
  {
    name: "a table and a composite type with the same name",
    files: {
      "a.sql":
        "create table point (x int, y int);\ncreate type point as (x int, y int);\n",
    },
    errors: [{ file: "a.sql", line: 2, rule: "duplicate-object" }],
  },
  {
    name: "the same function signature twice, spelled int and integer",
    files: {
      "a.sql":
        "create function f(x int) returns int language sql immutable return x;\n",
      "b.sql":
        "create function f(y integer) returns int language sql immutable return y + 1;\n",
    },
    errors: [
      {
        file: "b.sql",
        line: 1,
        rule: "duplicate-object",
        message: ["Routine f(int4)"],
      },
    ],
  },
  {
    name: "two comments on the same object",
    files: {
      "a.sql":
        "create table t (id int);\ncomment on table t is 'one';\ncomment on table t is 'two';\n",
    },
    errors: [
      {
        file: "a.sql",
        line: 3,
        rule: "duplicate-object",
        message: ["comment on table t"],
      },
    ],
  },
  {
    name: "a generated NOT NULL name used explicitly by another constraint",
    files: {
      "a.sql": "create table t (a int not null);\n",
      "b.sql":
        "create table u (b int constraint t_a_not_null check (b > 0));\n",
    },
    errors: [
      {
        file: "a.sql",
        line: 1,
        rule: "generated-name-collision",
        message: [
          "NOT NULL constraint on t.a t_a_not_null",
          "table u (data-model/desired-schema/b.sql:1)",
        ],
      },
    ],
  },
  {
    name: "a generated primary-key index name taken by an index",
    files: {
      "a.sql": "create table t (id int primary key, a int);\n",
      "b.sql": "create index t_pkey on t (a);\n",
    },
    errors: [
      {
        file: "b.sql",
        line: 1,
        rule: "duplicate-object",
        message: ["Relation t_pkey"],
      },
    ],
  },
  {
    name: "a generated identity sequence name taken by a table",
    files: {
      "a.sql":
        "create table t (id int generated always as identity);\ncreate table t_id_seq (n int);\n",
    },
    errors: [
      {
        file: "a.sql",
        line: 2,
        rule: "duplicate-object",
        message: ["Relation t_id_seq"],
      },
    ],
  },
  {
    name: "CREATE TABLE ... (LIKE ...) is refused",
    files: {
      "a.sql": "create table t (id int);\ncreate table u (like t);\n",
    },
    errors: [{ file: "a.sql", line: 2, rule: "table-like" }],
  },
  {
    name: "statements ordering can't model are refused",
    files: {
      "a.sql": "create sequence s;\ncreate type mood as enum ('happy');\n",
    },
    errors: [
      {
        file: "a.sql",
        line: 1,
        rule: "unorderable-statement",
        message: ["CreateSeqStmt"],
      },
      {
        file: "a.sql",
        line: 2,
        rule: "unorderable-statement",
        message: ["CreateEnumStmt"],
      },
    ],
  },
  {
    name: "a syntax error inside a LANGUAGE sql body",
    files: {
      "a.sql":
        "create table t (id int);\n\ncreate function f() returns int language sql as $$ selec 1 $$;\n",
    },
    errors: [
      {
        file: "a.sql",
        line: 3,
        rule: "syntax-error",
        message: ["function f()", "selec"],
      },
    ],
  },
  {
    name: "unknown functions, triggers and constraints",
    files: {
      "a.sql": `create table t (id int primary key, n int default make_n());
create trigger t_audit before insert on t for each row execute function audit();
comment on constraint t_missing on t is 'x';
comment on trigger t_nope on t is 'x';
create view v as select public.length('x') as l;
`,
    },
    errors: [
      {
        file: "a.sql",
        line: 1,
        rule: "unknown-reference",
        message: ["table t references function make_n"],
      },
      {
        file: "a.sql",
        line: 2,
        rule: "unknown-reference",
        message: ["function audit"],
      },
      {
        file: "a.sql",
        line: 3,
        rule: "unknown-reference",
        message: ["constraint t_missing on t"],
      },
      {
        file: "a.sql",
        line: 4,
        rule: "unknown-reference",
        message: ["trigger t_nope on t"],
      },
      {
        file: "a.sql",
        line: 5,
        rule: "unknown-reference",
        message: [
          "function public.length, which the desired schema doesn't create",
        ],
      },
    ],
  },
  {
    name: "a cycle between views",
    files: {
      "a.sql": "create view a as select x from b;\n",
      "b.sql": "create view b as select x from a;\n",
    },
    errors: [
      {
        file: "a.sql",
        line: 1,
        rule: "dependency-cycle",
        message: ["view a", "view b"],
      },
    ],
  },
  {
    name: "a function call in column syntax through parentheses",
    files: {
      "a.sql": `create table c (id int primary key);
create function score(x c) returns int language sql immutable return 1;
create view s as select (r).score from (select c as r from c) q;
`,
    },
    errors: [
      {
        file: "a.sql",
        line: 3,
        rule: "function-call-in-column-syntax",
        message: ["score"],
      },
    ],
  },
  {
    name: "a foreign key listing primary-key columns that also have a unique constraint",
    files: {
      "a.sql":
        "create table parent (id int primary key, constraint parent_id_key unique (id));\ncreate table child (parent_id int constraint child_parent_fk references parent (id));\n",
    },
    errors: [
      {
        file: "a.sql",
        line: 2,
        rule: "foreign-key-ambiguous-unique-key",
        message: ["constraint parent_id_key, constraint parent_pkey"],
      },
    ],
  },
];
