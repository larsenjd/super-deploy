# 04: Operators and operator classes in ordering

**What to build:** Desired schemas using an extension's operator classes and operators load reliably. Examples: a `gin_trgm_ops` trigram index, a `btree_gist` exclusion constraint, a `%` similarity operator in a view. Operator classes in index elements, and operators in expressions, become references. They resolve against the generated source at the pinned version, and get an ordering edge to their `CREATE EXTENSION`. The order-independence check's alternative order keeps every edge, so no load order can put a use before its extension. (Spec: "Ordering and references"; user story 13.)

**Blocked by:** 03

**Status:** resolved

- [x] Ordering fixtures prove each of these loads after its extension in both load orders:
  - an index using `gin_trgm_ops`;
  - an exclusion constraint using `gist_int4_ops` with `&&`;
  - a view using `%` from `pg_trgm`.
- [x] An operator class or operator that no extension in the desired schema provides, and `pg_catalog` doesn't have, is an unknown reference, naming it.
- [x] Integration test: a desired schema with a `gin_trgm_ops` index and `pg_trgm` drafts, finalizes and deploys, and the order-independence check passes.
- [x] Built-in operators and operator classes (from `pg_catalog`) keep working as before; the existing ordering fixtures pass unchanged.

## Comments

Operator classes are keyed by access method. Side effect: an operator name both pg_catalog and an extension have (e.g. `%`, `<->`) always orders after the extension. Deferred: the unqualified-name warning for routine bodies doesn't cover operators; operator families aren't checked (nothing in the desired schema names one).
