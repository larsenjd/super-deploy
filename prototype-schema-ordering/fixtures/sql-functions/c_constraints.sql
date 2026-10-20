-- A check that calls a LANGUAGE sql function reading its own table cannot be
-- written inline (cycle); ALTER TABLE ... ADD CONSTRAINT breaks it.
alter table accounts add constraint accounts_owner_known check (owner_ok(owner));
alter table accounts add constraint accounts_cap check (accounts_count() < 1000000);
