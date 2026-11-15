export const TESTS_BUILDINFO_REL: string;
export function isIncremental(env: Record<string, string | undefined>): boolean;
export function buildTscArgs(opts: {
  tscBin: string;
  tsconfigPath: string;
  repoRoot: string;
  env: Record<string, string | undefined>;
}): string[];
