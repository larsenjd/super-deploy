import { expect, test } from "vitest";
import { toolVersion } from "../../src/index.ts";

test("the library reports its own version", () => {
  expect(toolVersion).toBe("0.0.0");
});
