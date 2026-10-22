import { defineConfig } from "superdeploy";
import { embeddedPostgres } from "superdeploy/embedded-postgres";

// A private PostgreSQL 18 server in .super-deploy/postgres (gitignored). It
// provides the throwaway databases rehearsals need and the local `dev` target,
// and starts on a free port whenever a command needs it.
const postgres = embeddedPostgres({
  dataDir: new URL(".super-deploy/postgres/", import.meta.url),
});

export default defineConfig({
  postgresVersion: 18,
  rehearsal: postgres.rehearsal,
  targets: {
    dev: { adapter: postgres.target("dev") },
  },
});
