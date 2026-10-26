import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConfigError, loadProject, ProjectNotFoundError } from "super-deploy";
import { describe, expect, test } from "vitest";
import { createTestProject, embeddedConfig } from "../support/project.ts";

// The adapter starts its server lazily, so loading a project never needs one.
const unusedServer = { dataDir: "/nonexistent/super-deploy-config-test" };

function configWith(settings: string): string {
  return `import { defineConfig } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";

const postgres = embeddedPostgres({ dataDir: ${JSON.stringify(unusedServer.dataDir)} });

export default {
  rehearsal: postgres.rehearsal,
  ${settings}
};
`;
}

async function loadError(config: string): Promise<ConfigError> {
  const dir = await createTestProject({ config });
  const error = await loadProject({ cwd: dir.root }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConfigError);
  return error as ConfigError;
}

/**
 * The ConfigError `loadProject` throws for the project in `root`, loaded by a
 * plain Node process through dist/. Inside Vitest a config is imported through
 * Vitest's own transform, whose syntax errors are not Node's: only Node's
 * type stripping, which users run, reports where a syntax error is.
 */
async function nativeLoadError(
  root: string,
): Promise<{ configError: boolean; code: unknown; message: string }> {
  const script = `import { ConfigError, loadProject } from "super-deploy";
const error = await loadProject().then(() => new Error("loaded"), (e) => e);
process.stdout.write(JSON.stringify({ configError: error instanceof ConfigError, code: error.code, message: error.message }));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: root },
  );
  return JSON.parse(stdout);
}

describe("loadProject", () => {
  test("finds super-deploy.config.ts from a subdirectory and applies defaults", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(unusedServer),
      files: { "data-model/desired-schema/customers.sql": "" },
    });

    const project = await loadProject({
      cwd: dir.path("data-model/desired-schema"),
    });

    expect(project.root).toBe(dir.root);
    expect(project.config).toMatchObject({
      postgresVersion: 18,
      managedSchema: "public",
      historySchema: "deployment_history",
      externalSchemas: [],
      directory: "data-model",
    });
    expect(project.config.targets.dev).toMatchObject({
      name: "dev",
      lockTimeoutMs: 5000,
      statementTimeoutMs: undefined,
      connectTimeoutMs: 10_000,
    });
  });

  test("reads every setting", async () => {
    const dir = await createTestProject({
      config: configWith(`postgresVersion: 18,
  managedSchema: "app",
  historySchema: "app_history",
  externalSchemas: ["loader"],
  directory: "database",
  targets: { qa: { adapter: postgres.target("qa"), lockTimeout: "2s", statementTimeout: "1min", connectTimeout: "3s" } },`),
    });

    const project = await loadProject({ cwd: dir.root });

    expect(project.config).toMatchObject({
      managedSchema: "app",
      historySchema: "app_history",
      externalSchemas: ["loader"],
      directory: "database",
    });
    expect(project.config.targets.qa).toMatchObject({
      lockTimeoutMs: 2000,
      statementTimeoutMs: 60_000,
      connectTimeoutMs: 3000,
    });
    expect(project.paths.desiredSchema).toBe(
      dir.path("database/desired-schema"),
    );
  });

  test("has no warnings for PostgreSQL 18", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(unusedServer),
    });

    const project = await loadProject({ cwd: dir.root });

    expect(project.warnings).toEqual([]);
  });

  test("accepts another PostgreSQL version, warning that it is unsupported", async () => {
    const dir = await createTestProject({
      config: configWith("postgresVersion: 16,"),
    });

    const project = await loadProject({ cwd: dir.root });

    expect(project.config.postgresVersion).toBe(16);
    expect(project.warnings).toEqual([
      "postgresVersion 16 is unsupported: super-deploy is built and tested for PostgreSQL 18. It is an escape hatch for adopting a database; migrations are generated and rehearsed on 18 and may not run on 16",
    ]);
  });

  test("fails when there is no config in the directory or any parent", async () => {
    const dir = await createTestProject();

    await expect(loadProject({ cwd: dir.root })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  test.each([
    [
      'postgresVersion: "18",',
      "postgresVersion",
      "must be a PostgreSQL major version such as 18",
    ],
    [
      "postgresVersion: 16.4,",
      "postgresVersion",
      "must be a PostgreSQL major version such as 18",
    ],
    ["", "postgresVersion", "must be a PostgreSQL major version such as 18"],
    [
      "postgresVersion: 18, managedSchema: 'My Schema',",
      "managedSchema",
      "lowercase PostgreSQL identifier",
    ],
    [
      "postgresVersion: 18, historySchema: 'public',",
      "historySchema",
      "must differ from managedSchema",
    ],
    [
      "postgresVersion: 18, externalSchemas: 'loader',",
      "externalSchemas",
      "array",
    ],
    [
      "postgresVersion: 18, directory: '../elsewhere',",
      "directory",
      "inside the project",
    ],
    [
      "postgresVersion: 18, targets: { dev: {} },",
      "targets.dev.adapter",
      "deployment adapter",
    ],
    [
      "postgresVersion: 18, targets: { dev: { adapter: postgres.target('dev'), lockTimeout: 'soon' } },",
      "targets.dev.lockTimeout",
      "positive duration",
    ],
    [
      "postgresVersion: 18, targets: { dev: { adapter: postgres.target('dev'), connectTimeout: '5 seconds' } },",
      "targets.dev.connectTimeout",
      'must be a positive duration such as "500ms", "5s" or "2min", got "5 seconds"',
    ],
    [
      "postgresVersion: 18, managedSchemas: 'app',",
      "managedSchemas",
      "Unknown setting",
    ],
  ])("refuses %s naming the setting", async (settings, setting, problem) => {
    const error = await loadError(configWith(settings));

    expect(error.setting).toBe(setting);
    expect(error.message).toContain(`"${setting}"`);
    expect(error.message).toContain(problem);
  });

  test("refuses a config without a rehearsal adapter", async () => {
    const error = await loadError(
      `import { defineConfig } from "super-deploy";\nexport default defineConfig({ postgresVersion: 18 } as never);\n`,
    );

    expect(error.setting).toBe("rehearsal");
  });

  test("reports a config file that fails to load", async () => {
    const error = await loadError(`export default {;\n`);

    expect(error.message).toContain("Failed to load");
  });

  test("reports a syntax error in the config with its line and the source line", async () => {
    const dir = await createTestProject({
      config: `${configWith("postgresVersion: 18,")}this is not ts {\n`,
    });

    const error = await nativeLoadError(dir.root);

    expect(error).toMatchObject({ configError: true, code: "invalid-config" });
    expect(error.message).toMatch(/^super-deploy\.config\.ts:10: /);
    expect(error.message).toContain("this is not ts {");
  });

  test("reports an error the config throws as it runs at its line and the source line", async () => {
    const dir = await createTestProject({
      config: configWith("targets: { qa: { adapter: QA_DATABASE_URL } },"),
    });

    const error = await nativeLoadError(dir.root);

    expect(error).toMatchObject({ configError: true, code: "invalid-config" });
    expect(error.message).toBe(
      "super-deploy.config.ts:8: QA_DATABASE_URL is not defined in `targets: { qa: { adapter: QA_DATABASE_URL } },`",
    );
  });

  test("locates an error thrown by a function the config calls at the config's call", async () => {
    const dir = await createTestProject({
      config: `import { check } from "./check.ts";\n\ncheck();\n`,
      files: {
        "check.ts": `export function check(): void {\n  throw new Error("check failed");\n}\n`,
      },
    });

    const error = await nativeLoadError(dir.root);

    expect(error.message).toBe(
      "super-deploy.config.ts:3: check failed in `check();`",
    );
  });

  test("reports a module the config imports that throws as it loads without a location", async () => {
    const dir = await createTestProject({
      config: `import "./broken.ts";\n`,
      files: { "broken.ts": `throw new SyntaxError("not valid here");\n` },
    });

    const error = await nativeLoadError(dir.root);

    expect(error.message).toBe(
      "Failed to load super-deploy.config.ts: not valid here",
    );
  });
});
