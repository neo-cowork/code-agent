import type { InternalTextFormat } from '../../src/shared/internalTextLeakDetect';

type ScanOptions = { rendererDir?: string; repoRoot?: string };
type AllowlistEntry = {
  file: string;
  rule: InternalTextFormat;
  sample: string;
  reason: string;
};
type LeakHit = Omit<AllowlistEntry, 'reason'> & { line: number };

export function detectStaticStringLeaks(text: string, language?: 'zh' | 'en'): InternalTextFormat[];
export function scanRendererStatic(options?: ScanOptions): {
  filesScanned: number;
  rendererFilesScanned: number;
  hostCopyFilesScanned: number;
  hostCopyRoots: string[];
  hits: LeakHit[];
};
export function loadAndValidateAllowlist(allowlistPath?: string): AllowlistEntry[];
export function loadAndValidateDynamicAllowlist(allowlistPath?: string): AllowlistEntry[];
export function evaluateGate(options?: ScanOptions & { allowlistPath?: string }): {
  filesScanned: number;
  rendererFilesScanned: number;
  hostCopyFilesScanned: number;
  hostCopyRoots: string[];
  totalHits: number;
  allowlistCount: number;
  unexpectedHits: LeakHit[];
  staleEntries: AllowlistEntry[];
};
