-- parent(code) has TWO unique indexes (a unique index and a unique constraint).
-- PostgreSQL picks one of them for the FK (pg_constraint.conindid). Which one
-- may depend on creation order: a candidate residual order-dependence.
create table child (
  id int primary key,
  parent_code text references parent (code)
);
