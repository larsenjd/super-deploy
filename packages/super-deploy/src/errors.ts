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

/** Up to five items, then how many more. */
export function listed(objects: readonly string[]): string {
  const shown = objects.slice(0, 5).join(", ");
  return objects.length > 5 ? `${shown} and ${objects.length - 5} more` : shown;
}
