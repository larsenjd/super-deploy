// The base of the typed errors the programmatic API throws. Every error the
// library throws on purpose is a SuperDeployError subclass that declares its
// own `code`, stable and meant for programs; `message` is one line meant for
// people (the CLI prints it after "Error: "). Each subclass lives in the
// module that throws it, so tickets adding errors edit different files.

/**
 * Every stable `code`: computed from the error classes the package exports,
 * so a new error adds its code by declaring it on its class. An error whose
 * class isn't exported from index.ts fails to compile here.
 */
export type ErrorCode = {
  [Name in Exported]: Api[Name] extends abstract new (
    ...args: never[]
  ) => { readonly code: infer Code extends string }
    ? Code
    : never;
}[Exported];

type Api = typeof import("./index.ts");
// The base class is left out by name: its code is this type.
type Exported = Exclude<keyof Api, "SuperDeployError">;

export abstract class SuperDeployError extends Error {
  abstract readonly code: ErrorCode;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** `count` and the noun, plural unless the count is 1: "1 migration", "2 migrations". */
export function plural(
  count: number,
  noun: string,
  nouns = `${noun}s`,
): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

/**
 * Up to five items, `separator`-separated, then how many more: `a, b, c, d,
 * e and 2 more`. `; ` separates items that may hold commas themselves.
 */
export function listed(
  objects: readonly string[],
  separator: ", " | "; " = ", ",
): string {
  const shown = objects.slice(0, 5).join(separator);
  return objects.length > 5 ? `${shown} and ${objects.length - 5} more` : shown;
}

/** Every part, the last joined with "and": `a`, `a and b`, `a, b and c`. */
export function joined(parts: readonly string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * A thrown value as a reason for people, never empty. An `AggregateError`
 * (Node's for a refused connect to a host with several addresses, such as
 * `localhost`) has an empty message of its own: its inner errors' reasons,
 * deduplicated, joined with "; ". An error with no message falls back to its
 * `code`, e.g. `ECONNREFUSED`.
 */
export function errorReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.message !== "") {
    return error.message;
  }
  if (error instanceof AggregateError) {
    const inner = [...new Set(error.errors.map(errorReason))].filter(
      (reason) => reason !== "",
    );
    if (inner.length > 0) {
      return inner.join("; ");
    }
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : error.name;
}

/**
 * The SQLSTATE an error carries, if any. Node's own codes (`EPIPE`,
 * `ECONNRESET`) aren't SQLSTATEs: a SQLSTATE's class starts with a digit or
 * F, H, P or X.
 */
export function sqlStateOf(error: unknown): string | undefined {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  return typeof code === "string" && /^[0-9FHPX][0-9A-Z]{4}$/.test(code)
    ? code
    : undefined;
}

/**
 * How a session ended: by the server, by the server because its transaction
 * sat idle too long (`idle`: the idle-in-transaction timeout every target
 * session sets, deploy/target.ts), or by losing the connection.
 */
export type SessionEnding = "ended" | "idle" | "lost";

/** Node's codes for a socket that failed or closed under a connection. */
const socketFailures = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTCONN",
]);

/**
 * node-postgres's errors, which carry no code, for a connection that is gone
 * (pg/lib/client.js): it ended under a query, or a query was sent after.
 */
const pgConnectionGone =
  /^(?:Connection terminated(?: unexpectedly)?|Client has encountered a connection error and is not queryable|Client was closed and is not queryable)$/;

/**
 * Whether a statement's error says its session is gone, and how: `ended` by
 * the server (SQLSTATE 57P01-57P05, such as `pg_terminate_backend` or a
 * shutdown), `idle` (25P03, the idle-in-transaction timeout), or `lost` (class
 * 08, a socket error such as ECONNRESET, or node-postgres's own error for a
 * dropped connection, which has no code). Undefined when the server refused
 * the statement and the session lives on, for any other error without a
 * SQLSTATE (e.g. a custom adapter's), and for the library's own errors (e.g.
 * InterruptedError).
 */
export function sessionEnding(error: unknown): SessionEnding | undefined {
  if (error instanceof SuperDeployError) {
    return undefined;
  }
  const sqlState = sqlStateOf(error);
  if (sqlState === undefined) {
    return connectionGone(error) ? "lost" : undefined;
  }
  if (sqlState.startsWith("08")) {
    return "lost";
  }
  if (sqlState === "25P03") {
    return "idle";
  }
  return sqlState.startsWith("57P") ? "ended" : undefined;
}

function connectionGone(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { code } = error as { code?: unknown };
  return (
    (typeof code === "string" && socketFailures.has(code)) ||
    pgConnectionGone.test(error.message)
  );
}
