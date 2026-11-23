import * as path from 'node:path';
import { resolveInputPath } from '../../utils/resolveInputPath';

/** Pure, lexical destinations. Keep symlinks intact for the write-boundary classifier. */
export function resolveExcelWriteTargets(args: Record<string, unknown>, workingDir: string): string[] {
  if (!path.isAbsolute(workingDir)) return [];
  const raw = args.action === 'edit' ? args.file_path
    : args.action === 'generate' ? args.output_path
      : undefined;
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) return [];
  return [path.resolve(resolveInputPath(raw, workingDir))];
}

/** Materialize the generator's existing clock-based basename once per invocation.
 * The same args travel from permission/ownership checks to execution; the resolver
 * itself stays pure and never chooses a different filename at a later clock tick.
 */
export function materializeExcelGenerateOutput(args: Record<string, unknown>): void {
  if (args.action === 'generate' && args.output_path === undefined) {
    args.output_path = `spreadsheet-${Date.now()}.xlsx`;
  }
}
