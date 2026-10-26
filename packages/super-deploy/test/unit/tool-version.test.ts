import { readFile } from "node:fs/promises";
import { toolVersion } from "super-deploy";
import { expect, test } from "vitest";

test("the library reports its own package's version", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  expect(toolVersion).toBe(manifest.version);
});
