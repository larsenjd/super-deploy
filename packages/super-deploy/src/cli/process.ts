// The CLI process's interruptions: signals and closed output. The first one
// aborts `signal` (the running command then cleans up and the CLI exits with
// the interruption's code); a second signal exits at once, with two
// exceptions that keep cleanup going (ticket 141):
// - a repeat of the first signal within `sameInterruptionMs` is the same
//   interruption delivered twice: in a terminal the kernel signals the
//   foreground group and a wrapper such as `pnpm exec` forwards the same
//   signal a few milliseconds later;
// - SIGHUP never forces an exit: the terminal has gone, and no one is there
//   to insist.
// A signal prints one notice; closed output (e.g. `| head`) prints none, as
// other CLIs stay quiet there. Exit codes: 129 SIGHUP, 130 SIGINT, 141 closed
// output, 143 SIGTERM, 149 SIGBREAK. The code is also set as
// `process.exitCode` at once, so the process exits with it even if its event
// loop drains before the command ends.
//
// Once a command's outcome is settled (`commandSettled`: its function
// returned or threw), a signal while the CLI closes the project (stopping
// embedded servers) keeps that command's exit code, and its notice says the
// command had finished (ticket 144): a deploy that committed must not look
// failed to `deploy && ...` or CI. Closed output still exits 141: its writes
// fail asynchronously, often after the command has returned, and the output
// was cut short.

const signalExitCodes = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
  SIGBREAK: 149,
} as const;

export const closedOutputExitCode = 141;

/** How soon a repeat of the first signal still counts as the same interruption. */
const sameInterruptionMs = 1000;

/** A command whose function has returned or thrown, and the exit code it chose. */
export interface SettledCommand {
  readonly command: string;
  readonly exitCode: number;
}

export interface ProcessInterruptions {
  /** Aborts at the first interruption. */
  readonly signal: AbortSignal;
  /**
   * The exit code the first interruption requires, once there has been one:
   * its own, or the settled command's when it came after that command
   * finished.
   */
  readonly exitCode: number | undefined;
  /** True once stdout or stderr has closed: say nothing more. */
  readonly outputClosed: boolean;
  /**
   * Called once a command's outcome is settled, and with undefined when the
   * next command (in the menu) starts.
   */
  commandSettled(settled: SettledCommand | undefined): void;
}

export function watchInterruptions(): ProcessInterruptions {
  const controller = new AbortController();
  let exitCode: number | undefined;
  let first: { name: string; at: number } | undefined;
  let settled: SettledCommand | undefined;
  let outputClosed = false;

  const notice = (text: string) => {
    const lead = process.stderr.isTTY ? "\n" : "";
    try {
      process.stderr.write(`${lead}${text}\n`);
    } catch {
      // stderr is gone too; exit codes still tell the story.
    }
  };

  const interrupt = (code: number, reason: string) => {
    exitCode = code;
    process.exitCode = exitCode;
    controller.abort(new Error(reason));
  };

  for (const [name, code] of Object.entries(signalExitCodes)) {
    process.on(name, () => {
      if (exitCode !== undefined) {
        const repeat =
          name === first?.name && Date.now() - first.at < sameInterruptionMs;
        if (repeat || name === "SIGHUP") {
          return;
        }
        process.exit(exitCode);
      }
      first = { name, at: Date.now() };
      notice(
        settled === undefined
          ? `Interrupted by ${name}: cleaning up before exiting (interrupt again to exit at once)`
          : `Interrupted by ${name} after ${settled.command} finished: closing up before exiting (interrupt again to exit at once)`,
      );
      interrupt(settled?.exitCode ?? code, name);
    });
  }

  // Writing to a closed pipe fails with EPIPE (Node ignores SIGPIPE itself).
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => {
      outputClosed = true;
      if (exitCode === undefined) {
        interrupt(closedOutputExitCode, "closed output");
      }
    });
  }

  return {
    signal: controller.signal,
    get exitCode() {
      return exitCode;
    },
    get outputClosed() {
      return outputClosed;
    },
    commandSettled(command) {
      settled = command;
    },
  };
}
