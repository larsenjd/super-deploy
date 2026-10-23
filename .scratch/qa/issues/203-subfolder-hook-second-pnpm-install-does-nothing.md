# 203: In a project inside another Git repo, the README's "`pnpm install` then sets the repository's hooks" doesn't happen: pnpm skips `prepare` when already installed

**Status:** needs-triage
**Category:** docs
**Severity:** medium
**Area:** newproj
**Round:** 3

## What I did
Following `init`'s "Next:" line, then README "A project inside another Git repository":

```sh
mkdir mono && cd mono && git init
mkdir db && cd db
node <repo>/packages/super-deploy/dist/cli.js init
#   Next: pnpm install, add CREATE statements ...
#   The project is inside the Git repository at .../mono, so pnpm install won't install the pre-commit hook: see "A project inside another Git repository" in README.md
pnpm install                      # prepare: ".git can't be found"
# README: change prepare to "cd .. && husky db/.husky", start .husky/pre-commit with "cd db"
python3 -c 'import json;p="package.json";d=json.load(open(p));d["scripts"]["prepare"]="cd .. && husky db/.husky";open(p,"w").write(json.dumps(d,indent=2))'
printf 'cd db\npnpm precommit\n' > .husky/pre-commit
pnpm install
git -C .. config core.hooksPath
```

## Expected
README: "`pnpm install` then sets the repository's hooks to `db/.husky`", so `core.hooksPath` is `db/.husky/_` and commits run the hook.

## Actual
```
$ pnpm install
Already up to date
Done in 2ms using pnpm v12.14.0
$ git -C .. config core.hooksPath
(empty)
```

pnpm doesn't run `prepare` when nothing needs installing, so no hook is installed and commits go through unchecked, silently. `pnpm install --force` (or `pnpm run prepare`) does run it:

```
. prepare$ cd .. && husky db/.husky
. prepare: Done
```

after which the hook works from the repository root (a refused statement blocks the commit).

## Notes
- The natural order (init's "Next:" says `pnpm install` first, and the warning about the hook comes on the same screen) means almost everyone will have installed already when they edit `prepare`.
- Suggest the README say "run `pnpm run prepare`" (or `pnpm install --force`) and how to check it worked (`git config core.hooksPath`).
