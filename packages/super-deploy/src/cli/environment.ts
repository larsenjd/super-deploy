/** True in CI (the `CI` environment variable is set to anything but `false` or `0`): never prompt there. */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CI;
  return (
    value !== undefined && value !== "" && value !== "false" && value !== "0"
  );
}
