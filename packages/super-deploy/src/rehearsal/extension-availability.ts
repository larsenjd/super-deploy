// What a server holds and offers of the supported extensions (ADR-0009),
// shared by the deploy pre-flight (deploy/extension-preflight.ts), rebuild's
// wipe and every rehearsal:
// - `unitExtensionChanges`: the extension statements replay units run, read
//   from their SQL, never from the config: finalized migrations replay as
//   recorded. Only files mentioning an extension are parsed;
// - `unavailableVersions`: each version a statement names that the server's
//   pg_available_extension_versions lacks, with what it offers, worded once
//   by `offeredVersions`. Nothing ever falls back to another version;
// - `installedExtensions`: every extension in the database, with its schema
//   and owner, but plpgsql in pg_catalog (as drift reads them).

import type { Session } from "../adapters/types.ts";
import {
  compareExtensionVersions,
  type ExtensionChange,
  extensionChanges,
  parseSqlFile,
} from "../sql-analysis/index.ts";
import type { ReplayUnit } from "./replay.ts";

/** An extension statement of a replay unit. */
export interface UnitExtensionChange extends ExtensionChange {
  /** The unit's label, e.g. `00002-add-emails` or `draft add-emails`. */
  readonly unit: string;
}

/** Each extension statement in `units`' files, in run order. */
export async function unitExtensionChanges(
  units: readonly ReplayUnit[],
): Promise<UnitExtensionChange[]> {
  const found: UnitExtensionChange[] = [];
  for (const unit of units) {
    for (const { file, sql } of unit.files) {
      if (!/extension/i.test(sql)) {
        continue;
      }
      // Every file passed the deploy-time rules, so it parses.
      const parsed = await parseSqlFile({ path: file, text: sql });
      for (const change of extensionChanges(
        parsed.ok ? parsed.statements : [],
      )) {
        found.push({ ...change, unit: unit.label });
      }
    }
  }
  return found;
}

/** A version a statement names that the server doesn't offer. */
export type UnavailableVersion<T> = T & {
  readonly version: string;
  /** The versions of the extension the server offers, oldest first; empty when it offers none. */
  readonly available: readonly string[];
};

/**
 * Each of `wanted` whose version the server on `session` doesn't offer, the
 * first statement naming each extension and version only. Read-only.
 */
export async function unavailableVersions<
  T extends { readonly name: string; readonly version: string | undefined },
>(session: Session, wanted: readonly T[]): Promise<UnavailableVersion<T>[]> {
  const versioned = wanted.filter(
    (item): item is T & { version: string } => item.version !== undefined,
  );
  if (versioned.length === 0) {
    return [];
  }
  const { rows } = await session.query<{ name: string; version: string }>(
    "SELECT name, version FROM pg_catalog.pg_available_extension_versions WHERE name = ANY($1)",
    [versioned.map(({ name }) => name)],
  );
  const unavailable: UnavailableVersion<T>[] = [];
  for (const item of versioned) {
    const { name, version } = item;
    if (
      rows.some((row) => row.name === name && row.version === version) ||
      unavailable.some((u) => u.name === name && u.version === version)
    ) {
      continue;
    }
    const available = rows
      .filter((row) => row.name === name)
      .map((row) => row.version)
      .sort(compareExtensionVersions);
    unavailable.push({ ...item, available });
  }
  return unavailable;
}

/** `it offers citext 1.4, 1.5`, or `it doesn't offer citext`. */
export function offeredVersions(
  name: string,
  available: readonly string[],
): string {
  return available.length === 0
    ? `it doesn't offer ${name}`
    : `it offers ${name} ${available.join(", ")}`;
}

/** An extension installed in a database. */
export interface InstalledExtension {
  readonly name: string;
  /** The schema it lives in. */
  readonly schema: string;
  readonly owner: string;
}

/**
 * Every extension in the database on `session` but plpgsql in pg_catalog,
 * by name. Read-only.
 */
export async function installedExtensions(
  session: Session,
): Promise<InstalledExtension[]> {
  const { rows } = await session.query<InstalledExtension>(
    `SELECT e.extname AS name, n.nspname AS schema, pg_catalog.pg_get_userbyid(e.extowner) AS owner
       FROM pg_catalog.pg_extension e
       JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      WHERE NOT (e.extname = 'plpgsql' AND n.nspname = 'pg_catalog')
      ORDER BY e.extname COLLATE "C"`,
  );
  return rows;
}
