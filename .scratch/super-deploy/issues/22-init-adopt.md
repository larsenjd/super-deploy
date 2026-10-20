# 22: Init --adopt

**What to build:** A team brings an existing database under management: `init --adopt <target>` turns its managed schema into migration 1 and records it as already deployed there.

**Blocked by:** 20, 21

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] Generates desired-schema files from the target's managed schema and creates `00001-adopt`.
- [ ] Records it on the target as marked using `mark`'s replica check.
- [ ] Refuses with a full list of every object V1 doesn't support.
