// The one order of extension versions (ADR-0009): dotted numbers, `1.10`
// after `1.9`, then code-unit order, never the locale's, so the generated
// supported-extensions.ts and every message list versions alike everywhere.
// It imports nothing, so scripts/generate-supported-extensions.ts can use it
// without loading the file it regenerates.

/**
 * Orders extension versions as dotted numbers, `1.10` after `1.9`: negative
 * when `a` is the lower.
 */
export function compareExtensionVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
