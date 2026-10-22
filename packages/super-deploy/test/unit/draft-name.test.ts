import { InvalidDraftNameError, normaliseDraftName } from "superdeploy";
import { describe, expect, test } from "vitest";

describe("normaliseDraftName", () => {
  test.each([
    ["Add customers", "add-customers"],
    ["  Add   Customers\t", "add-customers"],
    ["add-customers", "add-customers"],
    ["Backfill 2026 prices", "backfill-2026-prices"],
    ["a".repeat(60), "a".repeat(60)],
  ])("normalises %j to %j", (input, expected) => {
    expect(normaliseDraftName(input)).toBe(expected);
  });

  test.each([
    ["Add customers!", '"!" is not allowed'],
    ["add_customers", '"_" is not allowed'],
    ["Café prices", '"é" is not allowed'],
    ["   ", "a name is required"],
    ["add - customers", "hyphens may only separate words"],
    ["-add-customers", "hyphens may only separate words"],
    ["a".repeat(61), "at most 60 characters"],
  ])("refuses %j", (input, reason) => {
    const attempt = () => normaliseDraftName(input);

    expect(attempt).toThrow(InvalidDraftNameError);
    expect(attempt).toThrow(reason);
  });

  test("shows the normalised result when refusing", () => {
    let error: unknown;
    try {
      normaliseDraftName("Add Customers!");
    } catch (e) {
      error = e;
    }

    expect(error).toMatchObject({
      input: "Add Customers!",
      normalised: "add-customers!",
    });
  });
});
