-- Inline FK cycle: unsatisfiable without ALTER TABLE ... ADD CONSTRAINT.
create table a (id int primary key, b_id int references b (id));
