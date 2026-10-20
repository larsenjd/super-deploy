# The desired schema is read by applying it to a throwaway database

To learn what the desired schema means, we apply its SQL to an empty throwaway database and read PostgreSQL's catalogs, rather than parsing the SQL and building our own model. PostgreSQL is the only fully correct interpreter of its own SQL: it resolves defaults, dependencies, name normalisation and implicit objects. Parsing ourselves would mean re-implementing that and drifting from it.

## Consequences

- Every draft, rehearsal and deployment needs a throwaway PostgreSQL 18 database, supplied by the rehearsal adapter.
- The SQL parser is used only to enforce rules, never to model the schema.
