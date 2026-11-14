# 05: Pre-flight for extensions

**What to build:** `status`, `deploy` and `deploy-draft` refuse, before any change, a target that couldn't run what the pending migrations (or the draft) do with extensions. There are three checks, each a typed, exported error with a one-line message:
- **(a) Version unavailable.** A pinned version (from `CREATE EXTENSION ... VERSION` or `UPDATE TO`) that isn't in the target's `pg_available_extension_versions`. The message names the extension, the version and what the target offers.
- **(b) No `CREATE` on the database.** The deploy role lacks `CREATE` on the database while anything pending creates an extension. The message names the extension and the exact `GRANT` a DBA must run. There is no check when nothing creates an extension.
- **(c) Already installed elsewhere.** An extension that would be created already exists in another schema. The message names that schema and the extension's owner, and says to move it with `ALTER EXTENSION ... SET SCHEMA` or drop it.

(Spec: "Pre-flight"; user stories 34–38.)

**Blocked by:** 03

**Status:** resolved

- [x] (a) With a migration pinning citext 1.8, a PostgreSQL 16 target (the existing test server, where citext stops at 1.6) is refused by `deploy` and reported by `status`, and nothing changes on it. The test uses the `postgresVersion` escape hatch, so older targets need no special case.
- [x] (b) A target where `CREATE` on the database was revoked from `deployer` is refused when a pending migration creates an extension, and accepted when none does.
- [x] (c) A target with citext already installed in `public` is refused when a pending migration creates citext, with the move-or-drop advice.
- [x] `deploy-draft` runs the same checks over the draft. At the API seam this is tested through its refusal path, as for other guarded commands.
- [x] No deploy transaction starts, and no failed attempt is recorded, for any of these refusals.
- [x] The template README's Permissions section says the deploy role needs `CREATE` on the database whenever a migration creates an extension.

## Comments

Pre-flight lives in deploy/extension-preflight.ts; `missingCreateExtensions` and `createExtensionMessage` are for ticket 08's rebuild refusal. Open question: check (c)'s advice to move the extension with ALTER EXTENSION ... SET SCHEMA doesn't let the pending CREATE EXTENSION succeed (extension names are database-unique), so only dropping it clears the way.

Code-review fix: check (c) became `ExtensionAlreadyInstalledError` (code `extension-already-installed`). It refuses an extension that already exists in any schema, unless a pending statement drops it first, and it advises dropping it.
