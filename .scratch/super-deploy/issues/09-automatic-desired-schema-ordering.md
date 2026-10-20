# 09: Automatic desired-schema ordering

**What to build:** A developer splits the desired schema across any files and folders with any names, and it loads correctly in one pass. Renaming files never changes the result, and order-dependent schemas are refused.

**Blocked by:** 02

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] Statements, not files, ordered by object-kind priority and dependencies; ties broken by object identity and statement-text hash only.
- [ ] Every reference shape bound at `CREATE` is modelled, including `BEGIN ATOMIC` bodies, unqualified names in `LANGUAGE sql` bodies, argument defaults, trigger `WHEN`, composite type attributes, `%TYPE`, `::regclass`, implicit `_pkey`/`_seq` names; PL/pgSQL bodies ignored for ordering.
- [ ] A call waits for every overload of its function name; circular foreign keys closed with `ALTER TABLE … ADD CONSTRAINT`.
- [ ] Unknown references and cycles reported with file and line before anything loads.
- [ ] Refused: unnamed indexes and constraints; foreign keys over columns with more than one unique index or constraint; function calls in column syntax.
- [ ] Order-independence check in `draft`, `rehearse` and `finalize`: a second load in a different valid order, catalogs and bindings compared; differences fail naming the objects.
- [ ] 60–100 fixtures at the SQL-analysis seam, asserting the order is unchanged when files are renamed and statement order reversed, including every case from `prototype/schema-ordering` (`25d5c18`) and `prototype/pg-topo-pg18` (`7f91fd6`).
