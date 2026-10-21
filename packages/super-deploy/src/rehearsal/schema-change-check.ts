// `draft`'s check of its own output (QA 102): the generated schema change
// runs once on the starting point `draft` built (the finalized migrations,
// then the draft's seed data and pre-migration script), and the result is
// compared with the desired schema as a draft rehearsal compares it
// (same-structure.ts). A refusal or a difference is a shortfall: `draft`
// reports it and still writes the draft, and the rehearsal would fail the
// same way. The post-migration script isn't run: the rules let it change
// only data (sql-analysis/deploy-time.ts), so it can't change the result.
//
// Also the causes a draft rehearsal's mismatch names when re-drafting won't
// help (rehearse-draft.ts), so `draft` and the rehearsal say the same thing.
// A difference pg-delta can't generate is named where it is recognised:
// a composite type's attributes in another order (research §8, "Silent
// gaps"). Any other difference comes from the pre-migration script, when
// there is one, or else from what pg-delta can't generate. Seed data and
// the post-migration script change only data, so they never cause one.
import type { Session } from "../adapters/types.ts";
import { quoteIdentifier } from "../sql-analysis/index.ts";
import type { FactDifference } from "../verification/catalog.ts";
import {
  type DeployTimeFile,
  type RehearsalSchemas,
  replay,
  SqlFileFailedError,
} from "./replay.ts";
import {
  catalogLines,
  differenceLines,
  differLabel,
  type StructuralDifferences,
  structuralDifferences,
} from "./same-structure.ts";

/** Where the generated schema change falls short of the desired schema. */
export interface SchemaChangeShortfall {
  /**
   * `fails`: PostgreSQL refused it on the starting point; `differs`: it ran,
   * but the result isn't the desired schema.
   */
  readonly kind: "fails" | "differs";
  /** One line: the cause, and what to do about it. */
  readonly message: string;
  /** For `differs`: the differences, as a rehearsal lists them. */
  readonly differences: readonly string[];
}

/**
 * Runs `schemaChange` on `source` (in a transaction of its own) and compares
 * the result with `desired`. Empty when it produces the desired schema.
 * `source` holds the schema change's result afterwards, unless it failed.
 */
export async function checkSchemaChange(
  source: Session,
  desired: Session,
  schemaChange: DeployTimeFile,
  schemas: RehearsalSchemas,
  draft: { readonly preMigrationScript: boolean },
): Promise<SchemaChangeShortfall[]> {
  const { managedSchema } = schemas;
  try {
    await replay(
      source,
      [{ label: "the generated schema change", files: [schemaChange] }],
      schemas,
    );
  } catch (error) {
    if (error instanceof SqlFileFailedError) {
      return [
        {
          kind: "fails",
          message: `The generated schema change can't run on the migrations, seed data and pre-migration script: ${error.message}`,
          differences: [],
        },
      ];
    }
    throw error;
  }
  const found = await structuralDifferences(source, desired, managedSchema);
  const { reordered, rest } = explained(found, managedSchema);
  const shortfalls: SchemaChangeShortfall[] = reordered.map(
    ({ type, differences }) => ({
      kind: "differs",
      message: capitalised(reorderCause(type)),
      differences: catalogLines(differences),
    }),
  );
  const lines = differenceLines(rest);
  if (lines.length > 0) {
    shortfalls.push({
      kind: "differs",
      message: `The generated schema change doesn't produce the desired schema: ${unexplainedCause(draft.preMigrationScript)}`,
      differences: lines,
    });
  }
  return shortfalls;
}

/**
 * Why a draft whose schema change is as `draft` wrote it, for an unchanged
 * desired schema, doesn't produce the desired schema: one clause per cause,
 * for the rehearsal's message.
 */
export function mismatchCauses(
  found: StructuralDifferences,
  managedSchema: string,
  draft: { readonly preMigrationScript: boolean },
): string[] {
  const { reordered, rest } = explained(found, managedSchema);
  const causes = reordered.map(({ type }) => reorderCause(type));
  if (differenceLines(rest).length > 0) {
    causes.push(unexplainedCause(draft.preMigrationScript));
  }
  return causes;
}

function reorderCause(type: string): string {
  return `the generated schema change doesn't reorder composite type ${type}'s attributes: ${differLabel} can't express it; drop and recreate the type in the pre-migration script (see the README, "Reordering a composite type's attributes")`;
}

function unexplainedCause(preMigrationScript: boolean): string {
  return preMigrationScript
    ? `the pre-migration script causes the difference, or ${differLabel} can't generate it (a column renamed in the pre-migration script needs its NOT NULL constraint renamed too: see the README, "Renaming a column")`
    : `${differLabel} can't generate the difference: make the change by hand in the pre-migration script`;
}

interface Reordered {
  /** The composite type, without the managed schema. */
  readonly type: string;
  readonly differences: readonly FactDifference[];
}

/**
 * The composite types whose differences are only their attributes'
 * positions (the same attributes on both sides, in another order, which
 * also covers one added in the middle), and every other difference.
 */
function explained(
  found: StructuralDifferences,
  managedSchema: string,
): { reordered: Reordered[]; rest: StructuralDifferences } {
  const byType = new Map<string, FactDifference[]>();
  for (const difference of found.catalog) {
    const type = compositeTypeOf(difference);
    if (type !== undefined) {
      byType.set(type, [...(byType.get(type) ?? []), difference]);
    }
  }
  const reordered: Reordered[] = [];
  for (const [type, differences] of byType) {
    const attributes = (side: FactDifference["side"]) =>
      differences
        .filter((difference) => difference.side === side)
        .map(({ fact }) => fact.line.replace(/ position=\d+$/, ""))
        .sort()
        .join("\n");
    if (attributes("actual") === attributes("expected")) {
      reordered.push({ type: unqualified(type, managedSchema), differences });
    }
  }
  const explainedFacts = new Set(
    reordered.flatMap(({ differences }) => differences),
  );
  return {
    reordered,
    rest: {
      statements: found.statements,
      catalog: found.catalog.filter(
        (difference) => !explainedFacts.has(difference),
      ),
    },
  };
}

/** The composite type a difference in an attribute's position is about. */
function compositeTypeOf(difference: FactDifference): string | undefined {
  const { fact } = difference;
  if (fact.kind !== "column" || !/ position=\d+$/.test(fact.line)) {
    return undefined;
  }
  return /^column .* of composite type (.+)$/.exec(fact.object)?.[1];
}

/** `public.size` → `size`, for the managed schema (named as pg_describe_object quotes it). */
function unqualified(name: string, managedSchema: string): string {
  const prefixes = [`${managedSchema}.`, `${quoteIdentifier(managedSchema)}.`];
  const prefix = prefixes.find((candidate) => name.startsWith(candidate));
  return prefix === undefined ? name : name.slice(prefix.length);
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
