# 08: Rebuild refusals

**What to build:** `rebuild` refuses before YES, naming the extension, in two cases:
- **An extension that would survive the wipe.** An extension outside the managed schema would still be there afterwards, and would be drift that blocks every deployment (ticket 02). The message names the extension and its schema.
- **A replay that needs `CREATE`.** The replay would create an extension, and the deploy role lacks `CREATE` on the database. The message uses the same wording and `GRANT` as ticket 05's pre-flight.

Either way the target is unchanged and no rebuild attempt is recorded. (Spec: "Rebuild"; user stories 44–45.)

**Blocked by:** 02, 05

**Status:** resolved

- [x] Pseudo-terminal test: on a disposable target with `pg_stat_statements` in `public`, `rebuild` refuses before asking YES, naming the extension and its schema. The target is unchanged and no attempt is recorded.
- [x] A disposable target whose deploy role lacks `CREATE` on the database, with a migration history that creates an extension, makes `rebuild` refuse before YES.
- [x] A disposable target with only managed extensions in the managed schema rebuilds as before. The wipe drops them, and the replay creates them again at their pinned versions.
- [x] The template README's description of `rebuild` mentions both refusals.

## Comments

The missing-CREATE refusal reuses ticket 05's `ExtensionCreateNotPermittedError`; an extension surviving the wipe throws `ExtensionSurvivesWipeError`.
