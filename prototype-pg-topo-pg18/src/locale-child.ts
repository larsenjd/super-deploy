// THROWAWAY spike. Run pg-topo's file adapter in a child process so the default ICU locale
// (taken from LANG / LC_ALL at Node start-up) can differ between runs.
// Usage: node src/locale-child.ts <variant index> <fixture dir>
import { loadVariants } from "./topo.ts";

const [vi, dir] = process.argv.slice(2);
const v = (await loadVariants())[Number(vi)]!;
const r = await v.mod!.analyzeAndSortFromFiles([dir!]);
process.stdout.write(
  JSON.stringify({
    locale: new Intl.Collator().resolvedOptions().locale,
    order: r.ordered.map((s) => ({ file: s.id.filePath, sql: s.sql })),
  }),
);
