// The one place the Differ is chosen (ADR-0003). Everything that diffs or
// records the differ in metadata uses `differ`, never an engine directly, so
// swapping to the fallback pg_catalog/pg_depend differ changes only this file.
import { pgDeltaDiffer } from "./pg-delta.ts";
import type { Differ } from "./types.ts";

export type { Differ, PlannedStatement } from "./types.ts";

export const differ: Differ = pgDeltaDiffer;
