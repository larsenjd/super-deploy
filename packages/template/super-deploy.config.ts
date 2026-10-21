import { defineConfig } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";

// Every setting, with its default, is in "Configuration" in README.md.

// A private PostgreSQL 18 server in .super-deploy/postgres (gitignored). It
// provides the throwaway databases rehearsals need and the local `dev` target,
// and starts on a free port whenever a command needs it.
const postgres = embeddedPostgres({
  dataDir: new URL(".super-deploy/postgres/", import.meta.url),
});

// A real target (QA, production) connects to an existing PostgreSQL 18
// server. To add one, replace the first import with
//   import { defineConfig, postgresTarget } from "super-deploy";
// and uncomment `qa` below. Its connection string is read from the
// environment variable QA_DATABASE_URL only when a command uses `qa`.
export default defineConfig({
  postgresVersion: 18,
  rehearsal: postgres.rehearsal,
  targets: {
    dev: { adapter: postgres.target("dev") },
    // qa: { adapter: postgresTarget({ env: "QA_DATABASE_URL" }) },
  },
});
