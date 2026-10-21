// The guard's question, asked at this process's own terminal (the guard has
// already checked that stdin and stdout are terminals). Ctrl+D on an empty
// answer cancels it, like Ctrl+C (`askUntilEndOfInput`).
import { isCancel, note, text } from "@clack/prompts";
import { askUntilEndOfInput } from "../end-of-input.ts";
import { throwIfInterrupted } from "../interruption.ts";

export interface GuardQuestion {
  /** e.g. `disposable: Mark target dev as disposable`. */
  readonly title: string;
  /** The target's details, one per line. */
  readonly lines: readonly string[];
  /** e.g. `Type YES to mark target dev as disposable`. */
  readonly question: string;
}

/**
 * Shows the details and resolves to exactly what was typed (no trimming), or
 * undefined if the question was cancelled. Throws InterruptedError if
 * `signal` aborted while asking.
 */
export async function askForYes(
  question: GuardQuestion,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  note(question.lines.join("\n"), question.title, { output: process.stdout });
  const answer = await askUntilEndOfInput(
    { input: process.stdin, output: process.stdout, signal },
    (streams) => text({ ...streams, message: question.question }),
  );
  throwIfInterrupted(signal);
  return isCancel(answer) ? undefined : (answer ?? "");
}
