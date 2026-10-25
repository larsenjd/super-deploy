# Snapshots are stored as diffs from the previous migration's

Each migration stores its snapshot as `desired-schema.diff`, a git-compatible diff of the desired-schema files against the previous migration's snapshot (migration 1's against an empty schema), rather than a full copy of the files. A full copy repeated the whole schema in every migration and in every migration's pull request, while the diff shows reviewers what changed in the desired schema. Snapshot N is rebuilt by applying diffs 1 to N strictly, without fuzz. We rejected normalizing the schema into one ordered file before diffing: `unfinalize` and `restore-schema` must give the user's own files back exactly, with their layout, comments and override markers, and files that don't change already produce no diff. We also rejected periodic full snapshots, because every command already verifies the whole hash chain, so a broken early migration fails either way.

## Consequences

- Reading any snapshot reads every migration before it; commands that need several build them in one forward pass.
- The diff is always written, empty when the desired schema didn't change, and finalize checks that applying it gives back exactly the current desired schema before the migration becomes read-only.
- Migrations with a `desired-schema/` folder, from 0.3.0 and earlier, are not read. No project used the library yet.
