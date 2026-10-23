# 226: The "desired schema already has files" refusal doesn't say what to do

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** adopt
**Round:** 3

## What I did
I adopted a target, then started following "Starting an adoption over". I
deleted `data-model/migrations/` but not yet the desired-schema files, then
adopted again:

```sh
pnpm exec super-deploy init --adopt qa          # succeeds
rm -rf data-model/migrations
pnpm exec super-deploy init --adopt qa </dev/null
```

## Expected
Like the other adopt-again refusals, it points to "Starting an adoption over",
or says what to do: move or delete those files, since adoption writes the
desired schema itself.

## Actual
With migrations present, the pointer is attached only to the migrations part:

```
Error: Cannot adopt target qa: the project already has migrations in data-model/migrations (to start the adoption over, see "Starting an adoption over" in README.md); the desired schema already has data-model/desired-schema/routines.sql, data-model/desired-schema/tables.sql, data-model/desired-schema/views.sql. Nothing was written
```

Without migrations, the refusal has no next step at all:

```
Error: Cannot adopt target qa: the desired schema already has data-model/desired-schema/routines.sql, data-model/desired-schema/tables.sql, data-model/desired-schema/views.sql. Nothing was written
```

## Notes
The README's "Adopting an existing database" never says that the desired schema must be
empty before adopting (only "before any draft or migration exists").
