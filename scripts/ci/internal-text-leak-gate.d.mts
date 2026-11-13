import type { InternalTextFormat } from '../../src/shared/humanizeInternalText';

type ScanOptions = { rendererDir?: string; repoRoot?: string };
type AllowlistEntry = {
  file: string;
  rule: InternalTextFormat;
  sample: string;
  reason: string;
};
type LeakHit = Omit<AllowlistEntry, 'reason'> & { line: number };

export function detectStaticStringLeaks(text: string): InternalTextFormat[];
export function scanRendererStatic(options?: ScanOptions): {
  filesScanned: number;
  hits: LeakHit[];
};
export function loadAndValidateAllowlist(allowlistPath?: string): AllowlistEntry[];
export function loadAndValidateDynamicAllowlist(allowlistPath?: string): AllowlistEntry[];
export function evaluateGate(options?: ScanOptions & { allowlistPath?: string }): {
  filesScanned: number;
  totalHits: number;
  allowlistCount: number;
  unexpectedHits: LeakHit[];
  staleEntries: AllowlistEntry[];
};
