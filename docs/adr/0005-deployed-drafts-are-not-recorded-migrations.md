# A deployed draft is recorded beside the migrations, and only rebuild clears it

`deploy-draft` runs the current draft on a disposable target, but a draft is not a finalized migration: it has no number, hash or chain entry and can still change. So it writes no `migrations` row. Instead, inside the same transaction, it writes the history schema's single `deployed_draft` row (name, hash of the files it ran, the recorded migration it went on top of, whether seed data was loaded, its attempt). We chose this over recording nothing (the target would look like plain drift, with no hint of why or how to fix it) and over recording the draft as a numbered migration (its hashes would never match the repo once the draft changed or was finalized).

## Consequences

- While the row exists, the target's structure is not that of its recorded migrations. The deploy pre-flight reports it as a history mismatch (`reason: "draft"`), so `deploy` refuses, `status` lists it under "Deploy would refuse" and doesn't check drift, `mark` should refuse, and `deploy-draft` refuses a second draft on top.
- `rebuild --to N` is the only way back: in one transaction it drops everything in the managed schema (the schema itself, its privileges and default privileges stay), deletes the recorded migrations and the `deployed_draft` row, and replays migrations 1 to N without seed data. The attempt log and the disposable flag are kept.
- `deploy-draft` needs the target at the newest finalized migration (the draft's schema change was generated on top of it), with its history matching the repo.
- A lost COMMIT of `deploy-draft` is settled like a deployment's, from whether the `deployed_draft` row with its attempt id exists.
