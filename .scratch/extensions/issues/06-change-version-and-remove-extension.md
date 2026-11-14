# 06: Changing a version and removing an extension

**What to build:** A developer can raise an extension's version, or remove an extension, through the desired schema. (Spec: "The differ wrapper", "Deploy-time rules", "Ownership"; user stories 22–25, 42.)

- **Raising the version.** Changing `VERSION '1.6'` to `'1.8'` makes `draft` add `ALTER EXTENSION citext UPDATE TO '1.8'` first in the schema change.
- **Lowering it.** Changing the version down is refused at `draft`, saying PostgreSQL has no downgrade scripts.
- **Removing it.** Taking the extension and its uses out of the desired schema makes `draft` generate `DROP EXTENSION citext`, without `CASCADE`, after the statements dropping each of its users.

The deploy-time rules accept `ALTER EXTENSION ... UPDATE TO` and `DROP EXTENSION <supported>` without `CASCADE`, in schema changes only. A version updated on a target by hand shows as drift.

**Blocked by:** 03

**Status:** resolved

- [x] Integration test:
  - Deploy citext 1.6.
  - Change the desired schema to 1.8 and list both versions in the config.
  - Draft: `UPDATE TO '1.8'` is the first statement in the schema change.
  - After finalize and deploy, the target has 1.8 and no drift.
- [x] Lowering 1.8 to 1.6 is refused at `draft` with a typed error.
- [x] Integration test: removing citext and the column using it drafts a schema change that drops the column, then `DROP EXTENSION citext` without `CASCADE`. After deploy, the target has no citext and no drift.
- [x] Removing the extension while a column still uses `citext` fails as an unknown reference.
- [x] The deploy-time rules refuse:
  - `DROP EXTENSION ... CASCADE`, anywhere;
  - `ALTER EXTENSION ... ADD`, `DROP` or `SET SCHEMA`;
  - `DROP EXTENSION` of an unsupported extension.
- [x] A target whose citext was updated by hand (`ALTER EXTENSION citext UPDATE TO '1.8'` run as `deployer` on a target its migrations put at 1.6) shows drift naming the version.
- [x] `DROP EXTENSION` isn't reported as destructive in itself. The column drops before it still are.
- [x] The ownership module's header no longer says a deployment never alters or drops an extension, and says why the deploy role can: it owns each extension it created.

## Comments

Gap found: the spec says an extension in the managed schema not owned by the deploy role is refused by the existing ownership pre-flight, but the ownership query doesn't cover extensions. The ownership header now describes the actual behaviour; no check was added.

Code-review fix: the ownership pre-flight, `mark` and `adopt` now refuse an extension in the managed schema that the deploy role doesn't own. The fix it prints drops the extension and creates it again as the deploy role.
