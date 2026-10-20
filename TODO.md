# TODO

## Projects created by `init` depend on a local path

`init` writes the library dependency as `"super-deploy": "link:<absolute path to this repo's packages/super-deploy>"` (`packages/super-deploy/src/commands/init.ts`, `projectManifest`). A project committed that way won't install on another machine, in CI, or after this repo moves.

Fix once the library is published to npm (REFINEMENTS.md, "Publishing"): write the exact version (`toolVersion`) instead of the `link:`, and update the init tests that expect the `link:`.
