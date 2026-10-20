// The roles SQL names: grantees, grantors and policy roles. Rehearsals create
// any of them the rehearsal server lacks (as NOLOGIN, never dropped), and the
// deploy pre-flight refuses a target that lacks one, so a GRANT can't fail
// mid-transaction. PUBLIC, CURRENT_USER and the like are not role names.
import { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";
import { walk } from "./syntax-tree.ts";

/** Every role named in the statements, sorted, without duplicates. */
export function rolesNamedIn(statements: readonly ParsedStatement[]): string[] {
  const roles = new Set<string>();
  for (const statement of statements) {
    walk(statement.node, (object) => {
      if (
        object.roletype === "ROLESPEC_CSTRING" &&
        typeof object.rolename === "string"
      ) {
        roles.add(object.rolename);
      }
    });
  }
  return [...roles].sort();
}

/**
 * Every role named in the files, sorted. A file that doesn't parse names no
 * roles here: running it reports the syntax error.
 */
export async function rolesNamedInFiles(
  files: readonly SqlFile[],
): Promise<string[]> {
  const statements: ParsedStatement[] = [];
  for (const file of files) {
    const parsed = await parseSqlFile(file);
    if (parsed.ok) {
      statements.push(...parsed.statements);
    }
  }
  return rolesNamedIn(statements);
}
