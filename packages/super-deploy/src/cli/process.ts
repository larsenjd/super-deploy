// The CLI process's interruptions: signals and closed output. The first one
// prints one notice and aborts `signal` (the running command then cleans up
// and the CLI exits with the interruption's code); a second signal exits at
// once. Exit codes: 129 SIGHUP, 130 SIGINT, 141 closed output, 143 SIGTERM,
// 149 SIGBREAK.

const signalExitCodes = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
  SIGBREAK: 149,
} as const;

export const closedOutputExitCode = 141;

export interface ProcessInterruptions {
  /** Aborts at the first interruption. */
  readonly signal: AbortSignal;
  /** The exit code the first interruption requires, once there has been one. */
  readonly exitCode: number | undefined;
}

export function watchInterruptions(): ProcessInterruptions {
  const controller = new AbortController();
  let exitCode: number | undefined;

  const notice = (text: string) => {
    const lead = process.stderr.isTTY ? "\n" : "";
    try {
      process.stderr.write(`${lead}${text}\n`);
    } catch {
      // stderr is gone too; exit codes still tell the story.
    }
  };

  const interrupt = (code: number, reason: string, text: string) => {
    exitCode = code;
    notice(text);
    controller.abort(new Error(reason));
  };

  for (const [name, code] of Object.entries(signalExitCodes)) {
    process.on(name, () => {
      if (exitCode !== undefined) {
        process.exit(exitCode);
      }
      interrupt(
        code,
        name,
        `Interrupted by ${name}: cleaning up before exiting (interrupt again to exit at once)`,
      );
    });
  }

  // Writing to a closed pipe fails with EPIPE (Node ignores SIGPIPE itself).
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => {
      if (exitCode === undefined) {
        interrupt(
          closedOutputExitCode,
          "closed output",
          "Output closed: cleaning up before exiting",
        );
      }
    });
  }

  return {
    signal: controller.signal,
    get exitCode() {
      return exitCode;
    },
  };
}
