# 10: Template README

**What to build:** A developer reading the template README can use supported extensions without reading the source. Tickets 03–09 each add the README lines for their own refusals and commands. This ticket adds the user-facing section that ties them together and checks the whole README reads consistently. (Spec: "Docs"; user stories 49–50.)

**Blocked by:** 03, 04, 05, 06, 07, 08, 09

**Status:** resolved

- [x] The README has a section on extensions covering:
  - the 17 supported extensions;
  - the config's `extensions` key, with an example;
  - that `VERSION` is required, and how raising it becomes `UPDATE TO` while lowering it is refused;
  - removing an extension;
  - calling extension functions in scripts.
- [x] The section says every extension in a target's database must be managed (database-wide drift, `plpgsql` excepted), and what to do about a DBA-installed one.
- [x] The README's lists of what the desired schema supports and refuses no longer say extensions other than `plpgsql` are refused. They say which extensions are refused and why. The README-coverage test passes.
- [x] The Permissions section, the `rebuild` section and the adoption section agree with what tickets 05, 08 and 09 wrote.
- [x] The README's index links to the new section.

## Comments

README advises dropping an extension installed in another schema; ticket 05's pre-flight message still suggests ALTER EXTENSION ... SET SCHEMA (to be reconciled in the code-review fix pass).
