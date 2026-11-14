// The pre-commit hook's runner: `pnpm precommit`, stopped with everything it started if it hasn't finished
// in five minutes. The checks take seconds; an agent's commit once sat for 22 minutes on a `validate` that
// had stopped doing anything, with nothing to say so. Stopping it fails the commit, which is loud.
import { spawn, spawnSync } from "node:child_process";

const limitSeconds = 300;
const windows = process.platform === "win32";

// Detached on POSIX, so the checks get a process group of their own and stopping it stops every child.
const child = spawn("pnpm", ["precommit"], {
  stdio: "inherit",
  detached: !windows,
  shell: windows,
});

function stopChecks(): void {
  if (windows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
  } else if (child.pid !== undefined) {
    process.kill(-child.pid, "SIGKILL");
  }
}

const timer = setTimeout(() => {
  console.error(
    `\npre-commit: the checks hadn't finished after ${limitSeconds} s, so they were stopped and the commit refused. Run \`pnpm precommit\` to see where they stop.`,
  );
  stopChecks();
}, limitSeconds * 1000);

// Ctrl+C reaches only the terminal's process group, which the detached checks have left.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    stopChecks();
    process.exit(1);
  });
}

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  process.exit(code ?? (signal ? 1 : 0));
});
