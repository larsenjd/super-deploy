# Gaps

Places where super-deploy doesn't do what the spec says it does: each one lets a wrong deployment through, or refuses a right one. Unlike REFINEMENTS.md, where V1 is narrow by choice, every entry here is a bug to fix. Each records what happens, why, and the fix.

## Attribute order of composite types

**What happens:** Composite types are supported, but reordering their attributes goes undetected. If the desired schema changes `app.size AS (width integer, height integer)` to `(height integer, width integer)`, the draft gets no statement for the type and the rehearsal passes. Targets keep `(width, height)`, while any database built fresh from the desired schema has `(height, width)`. Code that builds the value by position, such as `ROW(1080, 1920)::app.size`, the text form `'(1080,1920)'` or `(s).*`, then gives swapped values on one and not the other. Attributes of the same type swap silently; attributes of different types raise errors on one database only.

**Why:** pg-delta doesn't diff attribute order (pg-toolbelt #330/#332), and our `pg_catalog` comparison (`verification/catalog.ts`) never compares attribute position. Ignoring column order is deliberate for tables: PostgreSQL can't reorder a table's columns without rebuilding the table, and code names columns rather than relying on their position. Composite values are routinely built by position, so their attribute order is part of the type's meaning, but the catalog comparison applies the table rule to every relation kind.

**Fix:** Compare attribute position for composite types only (relkind `c` in the `column` query), so the rehearsal refuses a reordered type. PostgreSQL can't reorder attributes in place either, so the author then has to drop and recreate the type, and whatever uses it, in the migration's scripts.

**Research:** `.scratch/super-deploy/research/pg-delta-prototype.md` §1 and §8.
