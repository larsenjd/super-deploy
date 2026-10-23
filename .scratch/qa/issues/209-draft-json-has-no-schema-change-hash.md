# 209: README says `draft.json` holds a hash of the generated schema change; it holds only the desired schema's

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** newproj
**Round:** 3

## What I did
```sh
pnpm exec super-deploy draft --name "initial schema"
cat data-model/draft/draft.json
```

## Expected
README, "The files of a draft and a migration": "`draft.json` holds the draft's name, and hashes of the desired schema and the schema change `draft` generated, so `rehearse` can tell whether running `draft` again would help."

## Actual
```json
{
  "name": "initial-schema",
  "desiredSchemaHash": "12f030770a9fe8929c16563fecc5ad052d80c701be260faad0aa653e35583595"
}
```

No schema-change hash. (Hand-edit detection works, apparently by comparing with `schema-change.generated.sql`, which the next sentence of the README describes.)

## Notes
Drop "and the schema change `draft` generated" from that sentence, or say the comparison is with `schema-change.generated.sql`.
