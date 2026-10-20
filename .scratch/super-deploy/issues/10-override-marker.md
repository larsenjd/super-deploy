# 10: Override marker

**What to build:** A developer marks one justified dangerous statement, such as a loader function using dynamic SQL, with `-- OVERRIDE DANGEROUS COMMAND: <reason>`, and it is accepted but always visible to reviewers.

**Blocked by:** 06, 08

**Status:** resolved

**Spec:** `../spec.md`

- [ ] Exact form on the line before the statement, read from raw text between statements (PG18's parser excludes leading comments); reason required.
- [ ] Applies to one statement; recorded by object identity so regenerated schema changes honour it.
- [ ] Only risk rules (dynamic SQL, denylisted functions) can be overridden; transaction-breaking rules never.
- [ ] Overrides listed in migration metadata, `finalize` output and `validate`.
