// The guard: what every guarded command (disposable, deploy-draft, rebuild,
// mark) goes through before it changes a target. In order:
//   1. refuse in CI or without a terminal on stdin and stdout (before the
//      target is touched at all)
//   2. connect and, without waiting or taking it, check whether the target
//      lock is held: another attempt running is refused at once with the
//      TargetLockedError step 6 would give, before the person reads a target
//      state that attempt is about to change (QA 171). Two people can still
//      both reach the question; step 6's try-lock stays the real guard
//   3. read the target's view (host, database, recorded migrations, deployed
//      draft, disposable flag); the command checks its preconditions on it
//      and says what it is about to do (or that there is nothing to do)
//   4. show the action plus the target's name, host, database and last
//      recorded migration at the terminal. The host is the one the adapter
//      says it connects to (DeploymentAdapter.host), then the address the
//      server reports in brackets when it differs: behind a load balancer or
//      pooler the server's address alone is one the user may never have
//      seen. The fingerprint compares the server's address.
//   5. require YES, typed exactly (anything else, Escape or Ctrl+C refuses)
//   6. withLockedTarget: open the manual attempt (command name, OS username),
//      take the target lock
//   7. re-read the view under the lock: if what was shown has changed, refuse
//   8. run the command's body; the attempt ends as withLockedTarget decides
//
// Terminal-only by design: the guard reads this process's own stdin and
// stdout and asks there itself. There is no answer callback and no option,
// flag or environment variable that skips it, so a program can call a
// guarded command but a person still has to type YES.

import { hostAndPort } from "../adapters/ports.ts";
import type { Session } from "../adapters/types.ts";
import { isCI } from "../cli/environment.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { type LockedTarget, withLockedTarget } from "../deploy/engine.ts";
import {
  type DeployedDraft,
  type RecordedMigration,
  readDeployedDraft,
  readRecordedMigrations,
  readTargetSettings,
} from "../deploy/history.ts";
import { lockHolder, TargetLockedError } from "../deploy/lock.ts";
import { connectTarget, resolveTarget } from "../deploy/target.ts";
import { SuperDeployError } from "../errors.ts";
import type { Project } from "../project.ts";
import { adapterCall } from "../rehearsal/throwaway.ts";
import { migrationFolderName } from "../store/migrations.ts";
import { askForYes } from "./prompt.ts";

/** What the guard shows about a target, and what preconditions are checked on. */
export interface TargetView {
  readonly target: ResolvedTarget;
  /** The server's address as it reports it (`inet_server_addr`), or `local socket`. */
  readonly host: string;
  readonly database: string;
  /** In number order. */
  readonly recorded: readonly RecordedMigration[];
  /** The draft deploy-draft left on the target, if any. */
  readonly draft: DeployedDraft | undefined;
  readonly disposable: boolean;
}

/** The command goes ahead: `action` is shown, `plan` is handed to `run`. */
export interface Proceed<P> {
  /** One line, e.g. `Mark target dev as disposable`. */
  readonly action: string;
  /** More lines shown under the target's details, if any. */
  readonly details?: readonly string[];
  readonly plan: P;
}

/** Nothing to do: the guard returns `result` without asking or locking. */
export interface NothingToDo<T> {
  readonly nothingToDo: T;
}

export interface GuardedAction<P, T> {
  readonly command: GuardedCommand;
  /** The target's name in config. */
  readonly target: string;
  /**
   * Preconditions, before asking. Throw a typed error to refuse (nothing has
   * been written yet). `session` is the guard's read-only session.
   */
  check(
    view: TargetView,
    session: Session,
  ): Promise<Proceed<P> | NothingToDo<T>>;
  /** The command itself, under the lock and the manual attempt. `view` was re-read under the lock. */
  run(locked: LockedTarget, plan: P, view: TargetView): Promise<T>;
}

export async function runGuarded<P, T>(
  project: Project,
  action: GuardedAction<P, T>,
): Promise<T> {
  requireTerminal(action.command);
  const target = resolveTarget(project, action.target);

  const session = await connectTarget(target, project.signal);
  let shown: TargetView;
  let decision: Proceed<P> | NothingToDo<T>;
  let configured: string | undefined;
  try {
    await refuseIfLocked(project, target, session);
    shown = await readTargetView(project, target, session);
    decision = await action.check(shown, session);
    configured = await configuredHost(target);
  } finally {
    await session.close().catch(() => {});
  }
  if ("nothingToDo" in decision) {
    return decision.nothingToDo;
  }
  const proceed = decision;

  const answer = await askForYes(
    {
      title: `${action.command}: ${proceed.action}`,
      lines: [
        ...describeTarget(shown, configured),
        ...(proceed.details === undefined ? [] : ["", ...proceed.details]),
      ],
      question: `Type YES to ${lowerFirst(proceed.action)}`,
    },
    project.signal,
  );
  if (answer !== "YES") {
    throw new NotConfirmedError(action.command, target.name, answer);
  }

  return withLockedTarget(
    project,
    target.name,
    action.command,
    async (locked) => {
      const view = await readTargetView(project, target, locked.session);
      if (fingerprint(view) !== fingerprint(shown)) {
        throw new TargetChangedError(action.command, target.name);
      }
      return action.run(locked, proceed.plan, view);
    },
  );
}

/** Step 1: CI first (a CI runner may well have a terminal), then the terminal itself. */
function requireTerminal(command: GuardedCommand): void {
  if (isCI()) {
    throw new TerminalRequiredError(command, "ci");
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new TerminalRequiredError(command, "no-terminal");
  }
}

/** Step 2: another attempt holding the target lock refuses before anything is asked. */
async function refuseIfLocked(
  project: Project,
  target: ResolvedTarget,
  session: Session,
): Promise<void> {
  const holder = await lockHolder(session, project.config.historySchema);
  if (holder.pid !== undefined) {
    throw new TargetLockedError(target.name, holder);
  }
}

async function readTargetView(
  project: Project,
  target: ResolvedTarget,
  session: Session,
): Promise<TargetView> {
  const schema = project.config.historySchema;
  const { rows } = await session.query<{
    database: string;
    address: string | null;
    port: number | null;
  }>(
    "SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port",
  );
  const server = rows[0];
  const host =
    server?.address == null
      ? "local socket"
      : hostAndPort(server.address, String(server.port));
  return {
    target,
    host,
    database: server?.database ?? "",
    recorded: await readRecordedMigrations(session, schema),
    draft: await readDeployedDraft(session, schema),
    disposable: (await readTargetSettings(session, schema)).disposable,
  };
}

/** Where the target's adapter says it connects, if it says (see the header). */
async function configuredHost(
  target: ResolvedTarget,
): Promise<string | undefined> {
  const host = target.adapter.host?.bind(target.adapter);
  return host === undefined
    ? undefined
    : adapterCall(
        `The deployment adapter of target ${target.name}`,
        "say where it connects",
        host,
      );
}

function describeTarget(
  view: TargetView,
  configured: string | undefined,
): string[] {
  const last = view.recorded.at(-1);
  const host =
    configured === undefined || configured === view.host
      ? view.host
      : `${configured} (${view.host})`;
  return [
    `Target:    ${view.target.name}`,
    `Host:      ${host}`,
    `Database:  ${view.database}`,
    `Last recorded migration: ${last === undefined ? "none" : migrationFolderName(last.number, last.name)}`,
    ...(view.draft === undefined
      ? []
      : [
          `Deployed draft: ${view.draft.name} (attempt #${view.draft.attemptId})`,
        ]),
  ];
}

/** What must not change between showing the target and taking its lock. */
function fingerprint(view: TargetView): string {
  return JSON.stringify({
    host: view.host,
    database: view.database,
    disposable: view.disposable,
    recorded: view.recorded.map((m) => [
      m.number,
      m.chainHash,
      m.recovery ?? null,
    ]),
    draft: view.draft?.attemptId ?? null,
  });
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The commands that go through the guard (they ask for YES at a terminal). */
export type GuardedCommand = "disposable" | "deploy-draft" | "rebuild" | "mark";

/**
 * A guarded command was run in CI or without a terminal on stdin and stdout.
 * Nothing was read from or written to the target.
 */
export class TerminalRequiredError extends SuperDeployError {
  readonly code = "terminal-required";
  readonly command: GuardedCommand;
  readonly reason: "ci" | "no-terminal";

  constructor(command: GuardedCommand, reason: "ci" | "no-terminal") {
    super(
      `${command} ${reason === "ci" ? "never runs in CI" : "needs a terminal on stdin and stdout"}: run it yourself at a terminal, where it asks you to type YES`,
    );
    this.command = command;
    this.reason = reason;
  }
}

/** The person at the terminal did not type YES (or cancelled). Nothing changed. */
export class NotConfirmedError extends SuperDeployError {
  readonly code = "not-confirmed";
  readonly command: GuardedCommand;
  readonly target: string;
  /** What was typed instead of YES; undefined when the question was cancelled. */
  readonly typed: string | undefined;

  constructor(
    command: GuardedCommand,
    target: string,
    typed: string | undefined,
  ) {
    super(
      `${command} on target ${target} was not confirmed (${typed === undefined ? "cancelled" : `typed ${JSON.stringify(typed)}, not YES`}): nothing changed`,
    );
    this.command = command;
    this.target = target;
    this.typed = typed;
  }
}

/**
 * What was shown before YES changed by the time the command ran: the
 * target's recorded migrations, deployed draft or disposable flag (checked
 * under the lock), or what the command itself showed, e.g. what `rebuild`
 * drops outside the managed schema. Nothing changed; run the command again.
 */
export class TargetChangedError extends SuperDeployError {
  readonly code = "target-changed";
  readonly command: GuardedCommand;
  readonly target: string;

  /** `changed` says what changed, e.g. `what it drops outside schema public`. */
  constructor(
    command: GuardedCommand,
    target: string,
    changed = "its recorded migrations, deployed draft or disposable flag",
  ) {
    super(
      `Target ${target} changed while ${command} waited for YES (${changed}): nothing changed; run ${command} again to see the new details`,
    );
    this.command = command;
    this.target = target;
  }
}
