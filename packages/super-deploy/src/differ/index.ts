// The one place the Differ is chosen (ADR-0003). Everything that diffs or
// records the differ in metadata uses `differ`, never an engine directly, so
// swapping to the fallback pg_catalog/pg_depend differ changes only this file.
//
// Whatever the engine, `withExtensionVersions` pins each CREATE EXTENSION
// it plans to the desired side's version (ADR-0009).
import { withExtensionVersions } from "./extension-versions.ts";
import { pgDeltaDiffer } from "./pg-delta.ts";
import type { Differ } from "./types.ts";

export type { Differ, PlannedStatement } from "./types.ts";

export const differ: Differ = withExtensionVersions(pgDeltaDiffer);
export { DifferError } from "./types.ts";
