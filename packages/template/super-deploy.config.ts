import { defineConfig } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";

// Every setting, with its default, is in "Configuration" in README.md.

// Two private PostgreSQL 18 servers in .super-deploy (gitignored), each
// started whenever a command needs it. The local `dev` target is a database
// on the first, which listens on a fixed port so you can connect to it (see
// "Connecting to dev" in README.md). The second provides the throwaway
// databases rehearsals need, on a free port.
export const devServer = embeddedPostgres({
  dataDir: new URL(".super-deploy/dev/", import.meta.url),
  port: 54329,
});
const rehearsalServer = embeddedPostgres({
  dataDir: new URL(".super-deploy/rehearsal/", import.meta.url),
});

// A real target (QA, production) connects to an existing PostgreSQL 18
// server. To add one, replace the first import with
//   import { defineConfig, postgresTarget } from "super-deploy";
// and uncomment `qa` below. Its connection string is read from the
// environment variable QA_DATABASE_URL only when a command uses `qa`.
export default defineConfig({
  postgresVersion: 18,
  rehearsal: rehearsalServer.rehearsal,
  targets: {
    dev: { adapter: devServer.target("dev") },
    // qa: { adapter: postgresTarget({ env: "QA_DATABASE_URL" }) },
  },
});
