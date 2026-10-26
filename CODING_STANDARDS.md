# Coding standards

The judgement calls code is reviewed against. Mechanical rules live in tooling (Biome, jscpd, restricted imports), not here.

## Names come from the glossary

Where `GLOSSARY.md` defines a term, name the code after it (`seedData`, not `fixtures`), never after one of the term's _Avoid_ words. Give everything else names that stay clear of the defined terms, so a `target` is always a Target. Why: one word per concept, so code, spec, messages and reviews read the same.

## Build what the spec needs

Add a field, option, parameter or hook when a spec story or ticket needs it now. Why: each one is code to read, test and keep consistent, and it guesses at a future the spec hasn't decided.

## Tests assert behaviour

Assert what a user or integrator observes: files written, database state, typed errors and their codes, exit codes. Assert exact text, line counts or ordering of output only when that output is the behaviour under test, such as a documented CLI format. Why: tests pinned to incidental output break on harmless changes, and their failures say nothing about what a user would notice.

## Text is normalised once, where it enters

Normalise line endings with the store's `normaliseLineEndings`, once, where text enters a comparison, a hash or a file super-deploy writes. A file kept byte for byte (`desired-schema.diff`) is never normalised, and is marked `-text` in the root and the template's `.gitattributes`. Why: hashes ignore line endings, so text normalised twice, or converted by git, can change a snapshot without any integrity check noticing.

## Reuse before writing

Search for an existing helper before writing one: `src/`, `test/support/`, and the shared helpers `docs/agents/code-map.md` names. Extend one that nearly fits. Why: two helpers for one job drift apart, and each fix lands in only one of them.
