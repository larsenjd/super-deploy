// End of input at a terminal question cancels it, like Escape or Ctrl+C.
// Every clack prompt (the guard's YES question, the menu, the option
// questions, confirmations) is asked through `askUntilEndOfInput`.
//
// Why: clack reads keys through a readline interface but never listens for
// its `close`. Ctrl+D on an empty line, or stdin ending, closes readline and
// the prompt's promise never settles: depending on what else keeps the event
// loop alive, the process hangs or Node exits 13 ("unsettled top-level
// await"), with the cursor left hidden.
//
// How: the prompt gets a signal of its own (also aborted by the caller's), and
// end of input aborts it; clack answers an aborted signal by cancelling, which
// shows the cursor and resolves to its cancel symbol (`isCancel`). clack
// creates the readline interface inside `prompt()`, out of reach, so end of
// input is recognised from outside: the input stream ends, or Ctrl+D arrives
// and readline has let go of the input (closing pauses it). Ctrl+D after
// typing some text leaves readline open (it deletes, or does nothing), and
// the question keeps waiting.
import type { Readable, Writable } from "node:stream";

export interface PromptStreams {
  readonly input: Readable;
  readonly output: Writable;
  readonly signal: AbortSignal;
}

interface Keypress {
  readonly name?: string;
  readonly ctrl?: boolean;
}

/**
 * Asks `prompt` with `streams`, aborting the signal handed to it when the
 * input ends. Resolves to what the prompt resolves to.
 */
export async function askUntilEndOfInput<T>(
  streams: {
    readonly input: Readable;
    readonly output: Writable;
    readonly signal?: AbortSignal | undefined;
  },
  prompt: (streams: PromptStreams) => Promise<T>,
): Promise<T> {
  const { input } = streams;
  const ended = new AbortController();
  let settled = false;
  const endInput = () => ended.abort();
  const onKeypress = (_text: unknown, key: Keypress | undefined) => {
    if (key?.ctrl === true && key.name === "d") {
      // readline handles the key in its own listener, which may run after
      // this one: look once every listener has had it.
      setImmediate(() => {
        if (!settled && input.isPaused()) {
          endInput();
        }
      });
    }
  };
  input.on("keypress", onKeypress);
  input.once("end", endInput);
  try {
    return await prompt({
      input,
      output: streams.output,
      signal:
        streams.signal === undefined
          ? ended.signal
          : AbortSignal.any([streams.signal, ended.signal]),
    });
  } finally {
    settled = true;
    input.off("keypress", onKeypress);
    input.off("end", endInput);
  }
}
