export function runPrivateCheckCached(options: {
  root: string;
  privateRoot: string;
  run: () => unknown | Promise<unknown>;
  cacheDir?: string;
  entryPoints?: string[];
}): Promise<{ mode: 'reused' | 'ran'; inputHash: string }>;
