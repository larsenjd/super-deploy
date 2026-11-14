# 09: Adoption

**What to build:** `adopt` writes a supported extension in the managed schema, at a version the config lists, into the generated desired schema as `CREATE EXTENSION <name> VERSION '<v>';`, with nothing written for its members. It refuses any other extension once, with a reason naming which test it fails:
- not a supported extension;
- not listed in the config at its installed version;
- outside the managed schema.

(Spec: "Adoption"; user stories 46–48.)

**Blocked by:** 02, 03

**Status:** resolved

- [x] Integration test: a database whose managed schema holds citext 1.8 and a table with a `citext` column, adopted with `citext: ["1.8"]` in the config, gives a desired schema with `CREATE EXTENSION citext VERSION '1.8';` and the table. The adopted target then shows no drift, and a following `draft` finds nothing to change.
- [x] The same database adopted without citext in the config, or with only `["1.6"]`, is refused once for the extension, with the reason.
- [x] citext installed in `public` is refused once, saying it lives outside the managed schema. The existing tests for this case and for citext and pgcrypto refusals are updated to the new reasons.
- [x] An unsupported extension in the managed schema is refused once, saying it isn't supported.
- [x] The template README's adoption section describes what `adopt` does with extensions.

## Comments

README adoption section links to `#supported` until ticket 10 adds an extensions section. `extensionElsewhereFinding` in sql-analysis/extensions.ts words the move-or-drop advice; ticket 05's pre-flight may share it. Adoption doesn't check extension ownership.
