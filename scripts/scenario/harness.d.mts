export function isSameGitCommit(left: unknown, right: unknown): boolean;

export function resolveEnv(options: { slot?: number }): {
  slot: number;
  port: number;
  baseUrl: string;
  homeDir: string;
  dataDir: string;
  dbPath: string;
  tokenPath: string;
  token: string | null;
};

export function assertEnv(
  env: { baseUrl: string; token: string | null; dataDir?: string },
  options?: { requireCommit?: string },
): Promise<{
  api: {
    post(route: string, payload: unknown): Promise<{ status: number; body: unknown }>;
    get(route: string): Promise<{ status: number; body: unknown }>;
  };
  health: unknown;
  localHead: string;
  dirty: string;
}>;
