# 24: Rename the override marker

**What to build:** The override marker reads as what it does, overriding super-deploy's refusal of one statement: `-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>` replaces `-- OVERRIDE DANGEROUS COMMAND: <reason>`.

**Blocked by:** None (can start immediately)

**Status:** resolved

**Spec:** `../spec.md` (story 42, "Override marker"); `GLOSSARY.md` ("Override marker")

- [ ] The new form is the only one recognised; the old form is no longer a marker. No finalized migration anywhere contains the old form, so nothing frozen changes.
- [ ] A statement refused for a risk rule whose line before it starts with `-- OVERRIDE DANGEROUS COMMAND` gets a hint naming the new form.
- [ ] Every user-visible mention uses the new form: rule messages and hints, the rule catalogue, `finalize` and `validate` output, the template and its README, and the tests and fixtures.
- [ ] Overrides are still recorded by object identity in migration metadata; the metadata format is unchanged.
