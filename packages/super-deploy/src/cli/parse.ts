// Direct CLI mode: argv to an invocation. Unknown, repeated, missing or
// invalid options are usage errors, and nothing runs.
import { parseArgs } from "node:util";
import { InvalidDraftNameError } from "../errors.ts";
import { normaliseDraftName } from "../store/draft-name.ts";
import type {
  CommandDefinition,
  OptionDefinition,
  OptionValues,
} from "./definitions.ts";

export class UsageError extends Error {
  override name = "UsageError";
}

export type Invocation =
  | { kind: "no-command"; debug: boolean }
  | { kind: "help"; command: CommandDefinition | undefined }
  | { kind: "version" }
  | {
      kind: "run";
      command: CommandDefinition;
      values: OptionValues;
      debug: boolean;
    };

/** Options every command accepts. */
const commonOptions: readonly OptionDefinition[] = [
  {
    name: "debug",
    kind: "flag",
    description: "Show stack traces and causes on errors",
  },
  { name: "help", kind: "flag", description: "Show this help" },
];

export function optionsOf(
  command: CommandDefinition,
): readonly OptionDefinition[] {
  return [...command.options, ...commonOptions];
}

export function parseInvocation(
  argv: readonly string[],
  commands: readonly CommandDefinition[],
): Invocation {
  const [first, ...rest] = argv;
  if (first === undefined) {
    return { kind: "no-command", debug: false };
  }
  if (first === "--debug" && rest.length === 0) {
    return { kind: "no-command", debug: true };
  }
  if (first === "--help" || first === "-h") {
    return { kind: "help", command: undefined };
  }
  if (first === "--version") {
    return { kind: "version" };
  }
  if (first.startsWith("-")) {
    throw new UsageError(
      `Unknown option ${first}. Run "super-deploy --help" for usage.`,
    );
  }
  const command = commands.find((candidate) => candidate.name === first);
  if (command === undefined) {
    throw new UsageError(
      `Unknown command "${first}". Run "super-deploy --help" for usage.`,
    );
  }
  const hint = `Run "super-deploy ${command.name} --help" for usage.`;
  const definitions = optionsOf(command);
  const { tokens } = parseArgs({
    args: [...rest],
    options: Object.fromEntries(
      definitions.map((option) => [
        option.name,
        option.kind === "flag"
          ? option.name === "help"
            ? { type: "boolean" as const, short: "h" }
            : { type: "boolean" as const }
          : { type: "string" as const },
      ]),
    ),
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  const values: Record<string, string | boolean> = {};
  let problem: string | undefined;
  for (const token of tokens) {
    if (token.kind === "option-terminator") {
      continue;
    }
    if (token.kind === "positional") {
      problem ??= `Unexpected argument "${token.value}"`;
      continue;
    }
    const option = definitions.find(
      (candidate) => candidate.name === token.name,
    );
    if (option === undefined) {
      problem ??= `Unknown option ${token.rawName} for ${command.name}`;
    } else if (token.name in values) {
      problem ??= `Option --${option.name} was given more than once`;
    } else if (option.kind === "flag") {
      if (token.value !== undefined) {
        problem ??= `Option --${option.name} does not take a value`;
      } else {
        values[option.name] = true;
      }
    } else if (
      token.value === undefined ||
      (!token.inlineValue && token.value.startsWith("--"))
    ) {
      problem ??= `Option --${option.name} needs a value`;
    } else {
      values[option.name] = token.value;
    }
  }
  if (values.help === true) {
    return { kind: "help", command };
  }
  if (problem !== undefined) {
    throw new UsageError(`${problem}. ${hint}`);
  }
  for (const option of command.options) {
    const value = values[option.name];
    if (value === undefined) {
      if (option.required) {
        throw new UsageError(
          `Missing required option --${option.name}. ${hint}`,
        );
      }
      continue;
    }
    if (option.kind === "name" && typeof value === "string") {
      try {
        normaliseDraftName(value);
      } catch (error) {
        if (error instanceof InvalidDraftNameError) {
          throw new UsageError(error.message);
        }
        throw error;
      }
    }
    if (option.kind === "choice" && !option.choices.includes(String(value))) {
      throw new UsageError(
        `Option --${option.name} must be one of ${option.choices.join(", ")}. ${hint}`,
      );
    }
    if (option.kind === "migration" && !/^0*[1-9]\d*$/.test(String(value))) {
      throw new UsageError(
        `Option --${option.name} must be a migration number, e.g. 3 or 00003. ${hint}`,
      );
    }
  }
  const { debug, help: _help, ...commandValues } = values;
  return { kind: "run", command, values: commandValues, debug: debug === true };
}
