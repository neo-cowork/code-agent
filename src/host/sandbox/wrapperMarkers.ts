// Markers that identify a sandbox-wrapped command line (internal, never user-facing).
export const NPM_SANDBOX_TEMP_PREFIX = 'neo-npm-';

const SANDBOX_WRAPPER_MARKERS = ['sandbox-exec', NPM_SANDBOX_TEMP_PREFIX, 'bwrap '] as const;

export function looksSandboxWrapped(text: string): boolean {
  return SANDBOX_WRAPPER_MARKERS.some((marker) => text.includes(marker));
}
