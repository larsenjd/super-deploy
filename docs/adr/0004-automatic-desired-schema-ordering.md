# The desired schema is ordered automatically by our own utility

Desired-schema files load into a throwaway database in an order our own utility computes from `libpg-query@18` syntax trees: statements, not files, ordered by object kind and dependencies, with ties broken by object identity, never by file name. A second load in a different valid order checks that the result doesn't depend on order. We chose this over path order with numbered prefixes, pg-delta's retry loader and `@supabase/pg-topo` because all three let the resulting catalog depend on file names (a view silently binding to a different overloaded function, generated index names swapping), and pg-topo only parses PostgreSQL 17 and silently drops files it can't parse.

## Consequences

- Every index and constraint must be named; foreign keys over duplicate unique keys and function calls in column syntax are refused, because no ordering can make them deterministic.
- Two exceptions to the naming rule: an unnamed `PRIMARY KEY` and a column's `NOT NULL` are accepted, because PostgreSQL generates their names (`<table>_pkey`, `<table>_<column>_not_null`) from the table and column alone, so load order cannot change them.
- The ordering utility shares its parser with the rules engine, so it adds no dependency, but it is ours to maintain (about 2k lines plus fixtures).
