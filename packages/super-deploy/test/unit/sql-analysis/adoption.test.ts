// The SQL-analysis seam for adoption: the differ's statements for a whole
// database in, desired-schema files for the managed schema out.
import { describe, expect, test } from "vitest";
import { adoptedDesiredSchema } from "../../../src/sql-analysis/index.ts";

const options = { managedSchema: "app", header: ["Adopted."] };

async function kept(statements: string[]): Promise<Record<string, string>> {
  const files = await adoptedDesiredSchema(statements, options);
  return Object.fromEntries(files.map((file) => [file.path, file.text]));
}

describe("adopted desired schema", () => {
  test("sorts the managed schema's statements into one file per kind, in the differ's order", async () => {
    expect(
      await kept([
        'CREATE TABLE "app"."b" ("id" bigint NOT NULL);',
        'CREATE TABLE "app"."a" ("id" bigint NOT NULL)',
        "CREATE INDEX b_idx ON app.b USING btree (id);",
        'COMMENT ON COLUMN "app"."a"."id" IS \'Key\';',
        "CREATE OR REPLACE FUNCTION app.f()\n RETURNS integer\n LANGUAGE sql\nAS $function$select 1$function$;",
      ]),
    ).toEqual({
      "tables.sql":
        '-- Adopted.\n\nCREATE TABLE "app"."b" ("id" bigint NOT NULL);\n\nCREATE TABLE "app"."a" ("id" bigint NOT NULL);\n',
      "indexes.sql":
        "-- Adopted.\n\nCREATE INDEX b_idx ON app.b USING btree (id);\n",
      "routines.sql":
        "-- Adopted.\n\nCREATE FUNCTION app.f()\n RETURNS integer\n LANGUAGE sql\nAS $function$select 1$function$;\n",
      "comments.sql":
        '-- Adopted.\n\nCOMMENT ON COLUMN "app"."a"."id" IS \'Key\';\n',
    });
  });

  test("leaves out other schemas' objects and objects in no schema", async () => {
    expect(
      await kept([
        'CREATE SCHEMA "reporting";',
        'CREATE TABLE "reporting"."daily" ("day" date);',
        "CREATE INDEX daily_idx ON reporting.daily USING btree (day);",
        'COMMENT ON COLUMN "reporting"."daily"."day" IS \'x\';',
        'GRANT SELECT ON TABLE "reporting"."daily" TO "r";',
        'GRANT USAGE ON SCHEMA "app" TO "r";',
        "COMMENT ON SCHEMA \"app\" IS 'x';",
        'ALTER DEFAULT PRIVILEGES IN SCHEMA "app" GRANT SELECT ON TABLES TO "r";',
        'CREATE ROLE "r";',
        "CREATE EVENT TRIGGER e ON ddl_command_start EXECUTE FUNCTION reporting.f();",
        'CREATE DOMAIN "reporting"."d" AS integer;',
        'COMMENT ON CONSTRAINT "c" ON DOMAIN "reporting"."d" IS \'x\';',
      ]),
    ).toEqual({});
  });

  test("leaves out ownership, and objects the catalog check reports itself", async () => {
    expect(
      await kept([
        'ALTER TABLE "app"."t" OWNER TO "o";',
        "ALTER FUNCTION app.f() OWNER TO o;",
        'CREATE EXTENSION "pgcrypto" SCHEMA "app";',
        "COMMENT ON EXTENSION \"pgcrypto\" IS 'x';",
        'CREATE AGGREGATE "app"."agg"(integer) (SFUNC = int4pl, STYPE = integer);',
        "CREATE RULE r AS ON INSERT TO app.t DO INSTEAD NOTHING;",
        'CREATE PUBLICATION "p" FOR TABLE "app"."t";',
        "CREATE FUNCTION app.w() RETURNS integer LANGUAGE c WINDOW AS 'x', 'y';",
      ]),
    ).toEqual({});
  });

  test("keeps what the rules must refuse, so they can say why", async () => {
    const files = await kept([
      'CREATE TYPE "app"."mood" AS ENUM (\'sad\');',
      'CREATE SEQUENCE "app"."s" AS bigint;',
      'ALTER SEQUENCE "app"."s" OWNED BY "app"."t"."id";',
      'REVOKE ALL ON FUNCTION "app"."f"() FROM PUBLIC;',
      'ALTER TABLE "app"."t" REPLICA IDENTITY FULL;',
    ]);
    expect(Object.keys(files)).toEqual([
      "tables.sql",
      "sequences.sql",
      "types.sql",
      "grants.sql",
    ]);
  });
});
