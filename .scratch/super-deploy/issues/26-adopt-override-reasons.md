# 26: Override reasons during adoption

**What to build:** `init --adopt` can adopt a database whose functions need an override marker (dynamic SQL, denylisted calls). It asks for a reason per function and writes the marker, instead of refusing until those functions are removed from the target.

**Blocked by:** 24

**Status:** resolved

**Spec:** `../spec.md` (story 100, "`init`")

- [ ] In a terminal, adoption lists each function that needs a marker and the rules involved, then asks for a reason for each one. The reason is required and an empty answer cancels the adoption, with nothing written.
- [ ] The API takes a callback that receives each function's identity and rules and returns a reason; without a callback, or with no terminal in the CLI, adoption refuses and lists the functions as it does today.
- [ ] The generated desired-schema files carry `-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>` before each such function. `00001-adopt`'s metadata lists the overrides as for any migration, and `finalize`/`validate` show them.
- [ ] Anything else V1 refuses still refuses the whole adoption, listed all at once, and the reasons asked for are never used for it. Reasons are only asked once nothing else is refused.
- [ ] The template README's adoption section explains the reasons asked for.
