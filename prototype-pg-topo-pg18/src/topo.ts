// THROWAWAY spike. Loads the two pg-topo variants under test:
//  - "stock":    @supabase/pg-topo@1.0.0-alpha.8 exactly as published (PG17 parser chain)
//  - "override": the same tarball, with plpgsql-parser / @pgsql/traverse forced to the PG18 lines (pg18-override/)
import { fileURLToPath } from "node:url";

export interface TopoResult {
  ordered: { id: { filePath: string; statementIndex: number }; sql: string; statementClass: string; phase: string; provides: unknown[]; requires: unknown[] }[];
  diagnostics: { code: string; message: string; statementId?: { filePath: string; statementIndex: number }; details?: unknown; objectRef?: unknown }[];
  graph: { nodeCount: number; edges: unknown[]; cycleGroups: unknown[][] };
}
export interface TopoModule {
  analyzeAndSort(sql: string[]): Promise<TopoResult>;
  analyzeAndSortFromFiles(roots: string[]): Promise<TopoResult>;
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export async function loadVariants(): Promise<{ name: string; parser: string; mod?: TopoModule; loadError?: string }[]> {
  const out = [];
  for (const [name, path, parser] of [
    ["stock alpha.8", "../node_modules/@supabase/pg-topo/dist/index.js", "plpgsql-parser@0.5.16 -> @libpg-query/parser@17.6.10, @pgsql/traverse@17.2.6"],
    ["alpha.8 + PG18 overrides", "../pg18-override/node_modules/@supabase/pg-topo/dist/index.js", "plpgsql-parser@18.5.14 -> libpg-query@18.1.5, @pgsql/traverse@18.7.14 (forced)"],
  ] as const) {
    try {
      out.push({ name, parser, mod: (await import(here(path))) as TopoModule });
    } catch (e) {
      out.push({ name, parser, loadError: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
