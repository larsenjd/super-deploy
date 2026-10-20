// The CLI seam with a real terminal: spawns the built binary (dist/cli.js) in
// a pseudo-terminal, outside CI, so the menu and questions are allowed.
// Ctrl+C typed here reaches the CLI's whole process group, as in a terminal.
import { stripVTControlCharacters } from "node:util";
import { spawn } from "@lydell/node-pty";
import { onTestFinished } from "vitest";
import { cliPath } from "./cli.ts";

export const keys = {
  enter: "\r",
  escape: "\x1b",
  down: "\x1b[B",
  up: "\x1b[A",
  ctrlC: "\x03",
} as const;

export interface Terminal {
  /** Everything shown so far, without escape sequences. */
  readonly screen: string;
  /** Types into the terminal. */
  type(text: string): void;
  /** Waits until `text` appears after everything already waited for, and returns the screen up to it. */
  waitFor(text: string | RegExp, timeoutMs?: number): Promise<string>;
  /** Resolves with the exit code when the CLI exits. */
  readonly exited: Promise<number>;
}

export function spawnTerminal(
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
): Terminal {
  const { CI: _ci, ...env } = process.env;
  const pty = spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: { ...env, TERM: "xterm-256color", ...options.env },
    cols: 120,
    rows: 40,
  });
  let raw = "";
  let consumed = 0;
  const waiters = new Set<() => void>();
  pty.onData((data) => {
    raw += data;
    for (const check of waiters) {
      check();
    }
  });
  let done = false;
  const exited = new Promise<number>((resolve) => {
    pty.onExit(({ exitCode }) => {
      done = true;
      resolve(exitCode);
      for (const check of waiters) {
        check();
      }
    });
  });
  onTestFinished(() => {
    if (!done) {
      pty.kill("SIGKILL");
    }
  });

  const screen = () => stripVTControlCharacters(raw);
  return {
    get screen() {
      return screen();
    },
    type: (text) => pty.write(text),
    waitFor(text, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `Timed out waiting for ${String(text)}; screen:\n${screen().slice(consumed)}`,
            ),
          );
        }, timeoutMs);
        function check() {
          const rest = screen().slice(consumed);
          const match =
            typeof text === "string"
              ? { index: rest.indexOf(text), length: text.length }
              : (() => {
                  const found = text.exec(rest);
                  return found
                    ? { index: found.index, length: found[0].length }
                    : { index: -1, length: 0 };
                })();
          if (match.index >= 0) {
            waiters.delete(check);
            clearTimeout(timer);
            const upTo = rest.slice(0, match.index + match.length);
            consumed += match.index + match.length;
            resolve(upTo);
          } else if (done) {
            waiters.delete(check);
            clearTimeout(timer);
            reject(
              new Error(
                `Exited before showing ${String(text)}; screen:\n${rest}`,
              ),
            );
          }
        }
        waiters.add(check);
        check();
      });
    },
    exited,
  };
}
