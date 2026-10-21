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
  ctrlD: "\x04",
} as const;

/** The escape sequence that shows the terminal's cursor again. */
export const showCursor = "\x1b[?25h";

const menuTitle = "What do you want to do?";
const menuFooter = "Up/Down to move, Enter to run, Escape to leave";
/** More moves than the menu has items: the cursor has been everywhere. */
const maxMenuMoves = 50;

export interface Terminal {
  /** Everything shown so far, without escape sequences. */
  readonly screen: string;
  /** Everything written so far, escape sequences included. */
  readonly output: string;
  /** Types into the terminal. */
  type(text: string): void;
  /**
   * Waits until `text` appears after everything already waited for, and
   * returns the screen up to it. Gives up after 20 s by default, inside the
   * 30 s test timeout, so the failure shows the screen.
   */
  waitFor(text: string | RegExp, timeoutMs?: number): Promise<string>;
  /**
   * Runs the menu item labelled `label` (e.g. `deploy-draft`, `quit`): moves
   * the menu's cursor down, wrapping round, until the screen shows that item
   * selected, then presses Enter. Call it once the menu is showing (e.g. after
   * `waitFor("quit")`); later waits start after the menu.
   */
  chooseMenuItem(label: string): Promise<void>;
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
  /**
   * Resolves with what `found` returns once it returns something, checking
   * the screen as output arrives; rejects on timeout or exit.
   */
  const until = <T>(
    description: string,
    found: (text: string) => T | undefined,
    timeoutMs = 20_000,
  ) =>
    new Promise<T>((resolve, reject) => {
      const fail = (why: string) => {
        waiters.delete(check);
        clearTimeout(timer);
        reject(
          new Error(
            `${why} ${description}; screen:\n${screen().slice(consumed)}`,
          ),
        );
      };
      const timer = setTimeout(() => fail("Timed out waiting for"), timeoutMs);
      function check() {
        const result = found(screen());
        if (result !== undefined) {
          waiters.delete(check);
          clearTimeout(timer);
          resolve(result);
        } else if (done) {
          fail("Exited before showing");
        }
      }
      waiters.add(check);
      check();
    });

  return {
    get screen() {
      return screen();
    },
    get output() {
      return raw;
    },
    type: (text) => pty.write(text),
    async waitFor(text, timeoutMs) {
      const match = await until(
        String(text),
        (current) => {
          const rest = current.slice(consumed);
          if (typeof text === "string") {
            const index = rest.indexOf(text);
            return index < 0 ? undefined : index + text.length;
          }
          const found = text.exec(rest);
          return found === null ? undefined : found.index + found[0].length;
        },
        timeoutMs,
      );
      const upTo = screen().slice(consumed, consumed + match);
      consumed += match;
      return upTo;
    },
    async chooseMenuItem(label) {
      // Every menu redraw ends with the footer, and the selected item is the
      // one with the filled radio.
      const drawnAfter = (from: number) =>
        until("the menu", (current) =>
          current.indexOf(menuFooter, from) >= 0 ? true : undefined,
        );
      await drawnAfter(Math.max(0, screen().lastIndexOf(menuTitle)));
      for (let moves = 0; moves <= maxMenuMoves; moves++) {
        const selected = [...screen().matchAll(/●\s+(\S+)/g)].at(-1)?.[1];
        if (selected === label) {
          pty.write(keys.enter);
          consumed = screen().length;
          return;
        }
        const from = screen().length;
        pty.write(keys.down);
        await drawnAfter(from);
      }
      throw new Error(
        `The menu has no item ${label}; screen:\n${screen().slice(consumed)}`,
      );
    },
    exited,
  };
}
