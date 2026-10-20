# 03: Config discovery and adapters

Status: ready-for-agent
Type: task
Blocked by: 02
Spec: ../spec.md

## What

Implement `super-deploy.config.ts` loading and the adapter interfaces (spec §10).

## Acceptance criteria

- [ ] `defineConfig()` with the settings and defaults in spec §10; invalid config is a clear error naming the setting.
- [ ] Project discovery: nearest `super-deploy.config.ts` in cwd or parents; loaded with Node's built-in type stripping.
- [ ] Deployment-adapter and rehearsal-adapter interfaces (session: run SQL, query, server version, close; rehearsal: create throwaway DB with encoding/locale/collation provider, drop).
- [ ] node-postgres adapters from a connection string or environment variable.
- [ ] Refuse a server whose major version isn't 18.
- [ ] Adapters are called only when a command connects.
