import type { AwaitingApprovalRun } from '@shared/contract/sessionAutomation';

const PREVIEW_MAX_CHARS = 28;

type ApprovalCopy = {
  awaitingApprovalWithPreview: string;
  parkedVoided: { tools: { bash: string } };
};

/** Summary only: raw arguments remain in the approval card's deliberate disclosure. */
export function awaitingApprovalLabel(
  copy: ApprovalCopy,
  run?: Pick<AwaitingApprovalRun, 'tool' | 'commandPreview'>,
): string | null {
  const tool = run?.tool?.toLowerCase();
  if (tool === 'bash') {
    return copy.awaitingApprovalWithPreview.replace('{preview}', copy.parkedVoided.tools.bash);
  }
  if (tool !== 'write' && tool !== 'edit' && tool !== 'append') return null;
  const name = run?.commandPreview?.split(/[\\/]+/).filter(Boolean).pop()?.replace(/\s+/g, ' ').trim();
  if (!name) return null;
  const clipped = name.length > PREVIEW_MAX_CHARS ? `${name.slice(0, PREVIEW_MAX_CHARS - 1)}…` : name;
  return copy.awaitingApprovalWithPreview.replace('{preview}', clipped);
}
