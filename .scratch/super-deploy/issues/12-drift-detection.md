# 12: Drift detection

**What to build:** If someone changes a target's managed schema by hand, `status` reports the drift and exits 1, and `deploy` refuses.

**Blocked by:** 04

**Status:** resolved

**Spec:** `../spec.md`

- [ ] Replay the target's recorded migrations on a throwaway database created with the target's encoding, locale and collation provider.
- [ ] Any structural difference (column order and ownership ignored) is drift; no exceptions, including objects identical to what a pending migration would create.
- [ ] The deployment rehearsal reuses the drift replica and requires a match with the newest desired-schema snapshot.
- [ ] `status` names the drifted objects.
