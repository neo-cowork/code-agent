import type { ConfirmationPreview } from '../../../../shared/contract/confirmation';
import { redactCommandSecrets } from '../../../security/secretRedaction';

export function buildTerminalApprovalPreview(input: string): ConfirmationPreview {
  // details.command participates in Bash permission memory. Keep terminal text display-only.
  return { type: 'command', summary: input.trim() ? redactCommandSecrets(input) : JSON.stringify(input) };
}

export function terminalApprovalPreviewText(tool: string, preview: unknown): string | undefined {
  if (tool !== 'terminal_write' || !preview || typeof preview !== 'object') return undefined;
  const { type, summary } = preview as Partial<ConfirmationPreview>;
  return type === 'command' && typeof summary === 'string' ? summary : undefined;
}
