# 14: Failure handling

**What to build:** Whatever goes wrong during a deployment, the target is left exactly as it was and the attempt says what happened.

**Blocked by:** 04, 05

**Status:** resolved

**Spec:** `../spec.md`

- [ ] A failing script rolls back every pending migration; the attempt is recorded as failed with the error and the file.
- [ ] A second deployment fails immediately, naming the attempt holding the lock.
- [ ] A connection lost during COMMIT is recorded as unknown and settled as succeeded or failed on the next `status` or `deploy`.
- [ ] An interrupted deployment is recorded as abandoned and its lock released.
- [ ] Failures injected by wrapping a real adapter session, not by mocking internals.
