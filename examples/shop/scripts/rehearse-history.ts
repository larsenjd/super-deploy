// Rehearses this project's whole migration history against PostgreSQL 18:
// deploys every finalized migration (each one's newest variant, so Recoveries
// included) to an empty throwaway database, exactly as `super-deploy deploy`
// deploys them to a new target, then checks the result.
//
// `deploy` rehearses first: it replays the pending migrations on a second
// throwaway database and refuses unless the result matches the newest
// migration's desired-schema snapshot. After the real deployment, `status`
// must find nothing pending and no drift. Seed data is never loaded: it
// belongs only to its own draft's rehearsals.
//
// Run by `pnpm precommit` and CI: `node scripts/rehearse-history.ts`.
import { fileURLToPath } from "node:url";
import {
  deploy,
  loadProject,
  type Project,
  type ResolvedTarget,
  status,
} from "super-deploy";

const targetName = "history-rehearsal";

// On Ctrl+C the commands roll back and the throwaway databases are dropped.
const interruption = new AbortController();
let interruptedCode: number | undefined;
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    interruptedCode = code;
    interruption.abort();
  });
}

async function rehearseHistory(project: Project): Promise<string> {
  // An empty database on the project's rehearsal server.
  const database = await project.config.rehearsal.createDatabase({
    encoding: "UTF8",
    locale: "C",
    collationProvider: "libc",
  });
  try {
    const target: ResolvedTarget = {
      name: targetName,
      adapter: { connect: () => database.connect() },
      lockTimeoutMs: 5000,
      lockTimeoutSet: false,
      statementTimeoutMs: undefined,
      connectTimeoutMs: 10_000,
    };
    // The project as loaded, with the throwaway database as its only target.
    const rehearsing: Project = {
      ...project,
      config: { ...project.config, targets: { [targetName]: target } },
    };

    // Warnings (e.g. that the local deploy role is a superuser) don't matter
    // on a throwaway database.
    const { deployed } = await deploy(rehearsing, { target: targetName });
    const report = await status(rehearsing, { target: targetName });
    const problems = [
      ...report.pending.map(
        (migration) => `${migration.folder} is still pending`,
      ),
      ...(report.drift === undefined
        ? ["the recorded history doesn't match the project's migrations"]
        : report.drift.map(
            (object) =>
              `drift: ${object.object} ${object.change}: ${object.differences.join("; ")}`,
          )),
    ];
    if (problems.length > 0) {
      throw new Error(
        `The history deployed, but then:\n  ${problems.join("\n  ")}`,
      );
    }

    const newest = deployed.at(-1)?.folder ?? "no migration";
    const variants = report.recorded.map(
      (migration) =>
        String(migration.number).padStart(5, "0") +
        (migration.recovery === undefined
          ? ""
          : ` (Recovery ${migration.recovery})`),
    );
    return `Rehearsed the history on PostgreSQL 18: deployed ${variants.join(", ")} to an empty database; it matches ${newest}'s snapshot, with no drift`;
  } finally {
    await database.drop();
  }
}

let code = 0;
try {
  const project = await loadProject({
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    signal: interruption.signal,
  });
  try {
    console.log(await rehearseHistory(project));
  } finally {
    await project.close();
  }
} catch (error) {
  code = 1;
  console.error(`Error: ${error instanceof Error ? error.message : error}`);
}
// Exit explicitly, with the interruption's or the failure's code.
process.exit(interruptedCode ?? code);
