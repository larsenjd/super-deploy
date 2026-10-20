-- Rename the column in place so its values are kept. Without this script the
-- generated schema change would drop "name" with its data and add an empty
-- "full_name".
alter table customers rename column name to full_name;

-- PostgreSQL 18 names every NOT NULL constraint, and a column rename keeps the
-- old name. A fresh "full_name text not null" would be named
-- customers_full_name_not_null, so rename the constraint too, or the
-- rehearsal finds the two structures differ.
alter table customers
  rename constraint customers_name_not_null to customers_full_name_not_null;
