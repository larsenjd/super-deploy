# 19: Deploy-draft and rebuild

**What to build:** On a disposable target, a developer tries an unfinalized draft against realistic data, or resets the target to a known migration.

**Blocked by:** 15, 18

**Status:** resolved

**Spec:** `../spec.md`

- [ ] `deploy-draft --target X` deploys the current draft; seed data only with `--with-seed`, asked explicitly by the menu, default no.
- [ ] `rebuild --target X --to N` wipes the managed schema and replays migrations up to N, never loading seed data.
- [ ] Both refuse on non-disposable targets and go through the guard.
