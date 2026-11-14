# 09: Adoption

**What to build:** `adopt` writes a supported extension in the managed schema, at a version the config lists, into the generated desired schema as `CREATE EXTENSION <name> VERSION '<v>';`, with nothing written for its members. It refuses any other extension once, with a reason naming which test it fails:
- not a supported extension;
- not listed in the config at its installed version;
- outside the managed schema.

(Spec: "Adoption"; user stories 46–48.)

**Blocked by:** 02, 03

**Status:** ready-for-agent

- [ ] Integration test: a database whose managed schema holds citext 1.8 and a table with a `citext` column, adopted with `citext: ["1.8"]` in the config, gives a desired schema with `CREATE EXTENSION citext VERSION '1.8';` and the table. The adopted target then shows no drift, and a following `draft` finds nothing to change.
- [ ] The same database adopted without citext in the config, or with only `["1.6"]`, is refused once for the extension, with the reason.
- [ ] citext installed in `public` is refused once, saying it lives outside the managed schema. The existing tests for this case and for citext and pgcrypto refusals are updated to the new reasons.
- [ ] An unsupported extension in the managed schema is refused once, saying it isn't supported.
- [ ] The template README's adoption section describes what `adopt` does with extensions.
