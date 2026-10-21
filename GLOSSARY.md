# super-deploy

A deployment system that moves PostgreSQL databases from one version of their schema to the next through immutable, all-or-nothing migrations, generated from a declared schema.

## Authoring

**Desired schema**:
The SQL description of the database you want, kept in the project and edited by hand.
_Avoid_: Target schema, model

**Draft**:
The next migration while it is still being authored and can still change.
_Avoid_: Pending migration, WIP migration

**Migration**:
A numbered, finalized step from one version of the schema to the next. It never changes once finalized.
_Avoid_: Changeset, revision

**Schema change**:
The part of a migration the system generates from the difference between schemas, never edited by hand.
_Avoid_: Diff, generated migration

**Pre-migration script**:
Hand-written SQL that runs before a migration's schema change, for work the schema change cannot do on its own.
_Avoid_: Before script, up script

**Post-migration script**:
Hand-written SQL that runs after a migration's schema change.
_Avoid_: After script

**Seed data**:
Data belonging to one migration that reproduces a real target's problem conditions, so a rehearsal proves that migration's scripts handle them. It never reaches a target that isn't disposable.
_Avoid_: Fixtures, test data, sample data

**Recovery**:
A finalized replacement for a migration's scripts, used by targets that have not yet run that migration. It never changes the migration's schema change.
_Avoid_: Hotfix, patch, amended migration

**Override marker**:
The comment `-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>` on the line before one statement, which overrides super-deploy's refusal of that statement for a risk rule. The reason is recorded and always shown to reviewers.
_Avoid_: Dangerous command, escape hatch, suppression

## Deploying

**Target**:
A real, named database that receives deployments, such as `dev`, `qa` or `prod`.
_Avoid_: Environment, server

**Deploy role**:
The one database role the system connects to a target as, and the only role it knows about. It owns the managed schema and everything in it.
_Avoid_: Owner role, migration user, superuser

**Disposable target**:
A target that its own database has marked as safe to wipe and experiment on. Only disposable targets accept drafts, rebuilds and seed data.
_Avoid_: Scratch database, sandbox

**Managed schema**:
The single database schema the system owns and keeps in line with the desired schema.

**External schema**:
A schema outside the managed schema that routines in the desired schema may refer to, but which the system neither creates, nor reproduces in rehearsals, nor checks for on targets: the DBA sets it up.

**History schema**:
The schema the system keeps inside each target to record which migrations it has run, every deployment attempt, and whether it is disposable.
_Avoid_: Deployment schema, metadata schema

**Deployed draft**:
A draft that `deploy-draft` ran on a disposable target. The target records it beside its migrations, not as one, and refuses deployments until `rebuild` resets it.

**Pending migration**:
A migration that a given target has not yet recorded as deployed.

**Deployment**:
Applying every pending migration to a target as one all-or-nothing unit.
_Avoid_: Release, migration run

**Deploy-time SQL**:
Any SQL that runs against a target during a deployment: schema changes and scripts.

**Rehearsal**:
Replaying migrations on a throwaway database to prove they produce the desired schema.
_Avoid_: Dry run, test run

**Drift**:
Any difference between a target's managed schema and the structure its recorded migrations should have produced.
