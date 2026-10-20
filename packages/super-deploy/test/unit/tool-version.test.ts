import { toolVersion } from "super-deploy";
import { expect, test } from "vitest";

test("the library reports its own version", () => {
  expect(toolVersion).toBe("0.0.0");
});
