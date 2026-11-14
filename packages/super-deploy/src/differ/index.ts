// The one place the Differ is chosen (ADR-0003). Everything that diffs or
// records the differ in metadata uses `differ`, never an engine directly, so
// swapping to the fallback pg_catalog/pg_depend differ changes only this file.
//
// Whatever the engine, `withExtensionVersions` pins each CREATE EXTENSION
// it plans to the desired side's version, and plans raised versions
// (ADR-0009). A lowered version is `draft`'s refusal alone
// (`refuseExtensionDowngrades`); comparing structure, it is a difference.
import { withExtensionVersions } from "./extension-versions.ts";
import { pgDeltaDiffer } from "./pg-delta.ts";
import type { Differ } from "./types.ts";

export type { Differ, PlannedStatement } from "./types.ts";

export const differ: Differ = withExtensionVersions(pgDeltaDiffer);
export {
  ExtensionDowngradeError,
  refuseExtensionDowngrades,
} from "./extension-versions.ts";
export { DifferError } from "./types.ts";
