import { type TargetRollback, TargetSessionEndedError } from "superdeploy";
import { expect, test } from "vitest";

// Every report of a rolled-back transaction (a refused file, an ended
// session, the CLI's line after an interruption) shares one sentence; the
// session-ended error is the one whose constructor takes any rollback.
function endedSessionMessage(rollback: TargetRollback): string {
  const lost = Object.assign(new Error("Connection terminated"), {
    code: "ECONNRESET",
  });
  return new TargetSessionEndedError("dev", "lost", { cause: lost, rollback })
    .message;
}

test.each([
  [
    {
      command: "deploy",
      target: "dev",
      recorded: { lastRecorded: "00003-add-email" },
    },
    "The deployment rolled back: target dev is unchanged, still at migration 00003-add-email.",
  ],
  [
    { command: "deploy", target: "dev", recorded: { lastRecorded: undefined } },
    "The deployment rolled back: target dev is unchanged, with no migration recorded.",
  ],
  [
    {
      command: "deploy-draft",
      target: "dev",
      recorded: { lastRecorded: "00001-add-customers" },
    },
    "The draft's deployment rolled back: target dev is unchanged, still at migration 00001-add-customers (no draft deployed).",
  ],
  [
    {
      command: "disposable",
      target: "dev",
      recorded: { lastRecorded: undefined },
    },
    "The flag change rolled back: target dev is unchanged, with no migration recorded.",
  ],
] as const)("a rollback reads the same everywhere: %j", (rollback, line) => {
  expect(endedSessionMessage(rollback)).toContain(line);
});

test("a rollback whose position couldn't be read says so without a migration", () => {
  expect(
    endedSessionMessage({
      command: "deploy",
      target: "dev",
      recorded: undefined,
    }),
  ).toContain("The deployment rolled back: target dev is unchanged. Next:");
});
