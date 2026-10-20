Desired-schema files whose lexicographic (path) order is roughly the REVERSE of
their dependency order. Used to test whether a loader orders files by dependency.
Includes: a policy calling a LANGUAGE sql function (binds at CREATE), views on
views, a trigger, a BEGIN ATOMIC function, a domain + composite type, a PG18
VIRTUAL generated column, and an FK cycle closed by ALTER TABLE ... ADD CONSTRAINT
in a sub-folder.
