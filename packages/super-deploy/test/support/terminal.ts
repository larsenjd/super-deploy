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
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f",
  ctrlC: "\x03",
  ctrlD: "\x04",
} as const;

/** The escape sequence that shows the terminal's cursor again. */
export const showCursor = "\x1b[?25h";

const menuTitle = "What do you want to do?";
/** The footers of the menu's top (the sections) and of an open section. */
export const menuFooters = {
  top: "Up/Down to move, Enter or Right to open, Escape to leave",
  section: "Up/Down to move, Enter to run, Left to go back, Escape to leave",
} as const;
const menuFooter = new RegExp(`${menuFooters.top}|${menuFooters.section}`);
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
   * Waits for the menu, at its top or inside a section, like `waitFor`.
   */
  waitForMenu(): Promise<string>;
  /**
   * Chooses `item` at the menu's top (a section, or `quit`), then `command`
   * inside that section if given, e.g. `("Disposable", "deploy-draft")` or
   * `("quit")`. Goes back to the top if a section is open; for each, moves
   * the cursor down, wrapping round, until the screen shows it selected, and
   * presses Enter. Call it once the menu is showing (after `waitForMenu()`);
   * later waits start after the menu.
   */
  chooseMenuItem(item: string, command?: string): Promise<void>;
  /**
   * Sends a signal to the terminal's foreground process group, as closing
   * the terminal (SIGHUP) or `kill -TERM -<pgid>` does.
   */
  signalGroup(signal: NodeJS.Signals): void;
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
    // The CLI leads the terminal's session, so its pid is the group's id.
    signalGroup: (signal) => process.kill(-pty.pid, signal),
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
    waitForMenu() {
      return this.waitFor(menuFooter);
    },
    async chooseMenuItem(item, command) {
      // Every menu redraw ends with a footer, and the selected item is the
      // one with the filled radio.
      const drawnAfter = (from: number, footers: readonly string[]) =>
        until("the menu", (current) =>
          footers.some((footer) => current.indexOf(footer, from) >= 0)
            ? true
            : undefined,
        );
      await drawnAfter(Math.max(0, screen().lastIndexOf(menuTitle)), [
        menuFooters.top,
        menuFooters.section,
      ]);
      if (
        screen().lastIndexOf(menuFooters.section) >
        screen().lastIndexOf(menuFooters.top)
      ) {
        const from = screen().length;
        pty.write(keys.left);
        await drawnAfter(from, [menuFooters.top]);
      }
      // Moves the cursor onto `label`, redrawing with `footer`, then presses
      // Enter; resolves to the screen's length at that moment.
      const choose = async (label: string, footer: string) => {
        for (let moves = 0; ; moves++) {
          const selected = [...screen().matchAll(/●\s+(\S+)/g)].at(-1)?.[1];
          if (selected === label) {
            break;
          }
          if (moves === maxMenuMoves) {
            throw new Error(
              `The menu has no item ${label}; screen:\n${screen().slice(consumed)}`,
            );
          }
          const from = screen().length;
          pty.write(keys.down);
          await drawnAfter(from, [footer]);
        }
        const entered = screen().length;
        pty.write(keys.enter);
        return entered;
      };
      const entered = await choose(item, menuFooters.top);
      if (command !== undefined) {
        await drawnAfter(entered, [menuFooters.section]);
        await choose(command, menuFooters.section);
      }
      consumed = screen().length;
    },
    exited,
  };
}
