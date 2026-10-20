-- Existing addresses were stored as typed. Lower-case them so they pass the
-- new check constraint.
update customers set email = lower(email) where email <> lower(email);
