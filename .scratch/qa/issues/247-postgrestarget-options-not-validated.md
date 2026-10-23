# 247: `postgresTarget` accepts both `env` and `connectionString` (one silently ignored) and an empty `env` name

**Status:** needs-triage
**Category:** bug
**Severity:** low
**Area:** fail
**Round:** 3

## What I did
In a project made with `init`, with `QA_DATABASE_URL` set to a working connection string, I changed the `qa` target in `super-deploy.config.ts` three ways and ran `pnpm exec super-deploy validate` and `pnpm exec super-deploy status --target qa` each time:

```ts
qa: { adapter: postgresTarget({ env: "QA_DATABASE_URL", connectionString: "postgres://x@y/z" }) },
```
```ts
qa: { adapter: postgresTarget({ env: "" }) },
```
```ts
qa: { adapter: postgresTarget({}) },
```

## Expected
The README describes `postgresTarget({ env: "..." })` and `postgresTarget({ connectionString: "..." })` as alternatives, and says "super-deploy refuses any other" setting. I expected giving both, or an empty variable name, to be refused as an invalid setting naming `targets.qa`, like other config mistakes (`Invalid setting "targets.bad name" ...`).

## Actual
- Both given: `validate` passes, and `status` connects using `QA_DATABASE_URL` and ignores `connectionString`, without a word. A user who wrote a literal for a one-off test can't tell which one is used.
- `env: ""`: `validate` passes; `status` says
  ```
  Error: Target qa: environment variable  is not set
  ```
  (an empty name, two spaces).
- `{}`: `status` says `Target qa has no connection string (connectionString is undefined): set one in super-deploy.config.ts, usually from an environment variable with postgresTarget({ env: "DATABASE_URL" })`. This one is clear, but like the others it only shows up when a command connects, not in `validate`.
