// A yes/no question at the terminal, default no: the CLI's answer to a
// command's `confirm` callback. Only used with a terminal on stdin and stdout
// outside CI; without one, commands refuse unless the flag is passed.
import { createInterface } from "node:readline/promises";
import type { Question } from "../questions.ts";

export function terminalConfirm(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): (question: Question) => Promise<boolean> {
  return async (question) => {
    for (const path of question.paths) {
      output.write(`  ${path}\n`);
    }
    const lines = createInterface({ input, output });
    try {
      const answer = await lines.question(`${question.message} [y/N] `);
      return /^\s*y(es)?\s*$/i.test(answer);
    } finally {
      lines.close();
    }
  };
}

/** True in CI (the `CI` environment variable is set to anything but `false` or `0`): never ask there. */
export function inCI(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CI;
  return (
    value !== undefined && value !== "" && value !== "false" && value !== "0"
  );
}
