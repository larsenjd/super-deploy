import { SuperDeployError } from "../errors.ts";

export const maxDraftNameLength = 60;

/**
 * Normalises a typed draft name: trims it, lowercases it and collapses each
 * run of spaces into one hyphen. The result must be kebab-case (lowercase
 * letters and digits in hyphen-separated words) of at most 60 characters;
 * anything else is refused, showing the normalised result.
 */
export function normaliseDraftName(input: string): string {
  const normalised = input.trim().toLowerCase().replace(/\s+/g, "-");
  const refuse = (reason: string) =>
    new InvalidDraftNameError(input, normalised, reason);
  if (normalised === "") {
    throw refuse("a name is required");
  }
  const invalid = [...new Set(normalised.replace(/[a-z0-9-]/g, ""))];
  if (invalid.length > 0) {
    const listed = invalid
      .map((character) => JSON.stringify(character))
      .join(", ");
    throw refuse(
      `${listed} ${invalid.length === 1 ? "is" : "are"} not allowed; use letters, digits, spaces and hyphens`,
    );
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(normalised)) {
    throw refuse(
      "hyphens may only separate words (no leading, trailing or repeated hyphens)",
    );
  }
  if (normalised.length > maxDraftNameLength) {
    throw refuse(
      `at most ${maxDraftNameLength} characters, got ${normalised.length}`,
    );
  }
  return normalised;
}

export class InvalidDraftNameError extends SuperDeployError {
  readonly code = "invalid-draft-name";
  readonly input: string;
  /** The input after trimming, lowercasing and collapsing spaces. */
  readonly normalised: string;

  constructor(input: string, normalised: string, reason: string) {
    super(
      `Invalid draft name ${JSON.stringify(input)} (normalised: ${JSON.stringify(normalised)}): ${reason}`,
    );
    this.input = input;
    this.normalised = normalised;
  }
}
