# 01: Supported extensions and the `extensions` config key

**What to build:** Put the supported set the agent chose while grilling into the library, as a single source every later ticket reads, and let a project's config narrow it (spec: `.scratch/extensions/spec.md`, "The supported set", "Generated object lists", "Config"; ADR-0009). The set is 17 extensions, each with the versions it can be installed at; research file §1 has the table.

The ticket delivers three things:
- **A generation script.** It produces, as committed source, what each supported extension provides at each installable version: types, functions with their argument types, operators, operator classes and operator families. It reads them from embedded PostgreSQL 18.4, installing each extension at each version into a fresh database.
- **The config key.** An optional `extensions` key: supported-extension name to a non-empty list of versions. `resolveConfig` validates it against the generated source.
- **A check script for maintainers.** It connects to any server by connection string and compares its `pg_available_extension_versions` with the supported set, extension by extension: present, trusted, and the versions offered against the versions the tool knows. It prints a pass/fail report. Ticket 11 runs it against a real Aurora 18.4 cluster to confirm these choices, so its report must be readable by a human and say exactly what differs.

No desired-schema behaviour changes yet: extensions other than `plpgsql` are still refused until ticket 03.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] The supported set is exactly the 17 in the spec, and the generated source lists, for each one, the installable versions in research file §1 (for example citext 1.4–1.8, pgcrypto 1.3–1.4).
- [x] The generated source holds each extension's types, functions (with argument types), operators, operator classes and operator families per version. Running the generation script again on the same embedded-postgres gives byte-identical output.
- [x] A config with `extensions: { citext: ["1.6", "1.8"] }` loads. With no `extensions` key, the default is empty and nothing behaves differently.
- [x] `resolveConfig` refuses:
  - an unsupported name, listing the supported names;
  - a version the tool doesn't know, with the message "citext 1.9 is not a supported version: supported versions are 1.4, 1.5, 1.6, 1.7, 1.8";
  - an empty version list;
  - a duplicated version.

  Each refusal is a typed error exported from the public API.
- [x] The check script, run in an integration test against the embedded PostgreSQL 18 test server, reports a pass for all 17 extensions.
- [x] Against a server that lacks a version or an extension, or doesn't trust one, the check script reports which extension, what was expected and what the server has. The test simulates this with an extension the tool doesn't support, or by comparing against a doctored expectation.
- [x] The check script's usage (how to run it with a connection string, and what each line of the report means) is in the header of the script, so ticket 11 can follow it without reading the code.
