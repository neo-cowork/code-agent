import type { MessageAttachment } from '@shared/contract';

interface AttachmentMergeResult {
  attachments: MessageAttachment[];
  skippedCount: number;
  duplicates: Array<{ incoming: MessageAttachment; existing: MessageAttachment }>;
}

function isSameAttachment(a: MessageAttachment, b: MessageAttachment): boolean {
  if (a.path && b.path) return a.path === b.path;
  if (a.name !== b.name || a.size !== b.size || a.data !== b.data) return false;
  if (a.category === 'folder' || b.category === 'folder') {
    return JSON.stringify(a.files ?? []) === JSON.stringify(b.files ?? []);
  }
  return true;
}

export function mergeAttachments(
  existing: MessageAttachment[],
  incoming: MessageAttachment[],
  cap: number,
): AttachmentMergeResult {
  const merged = [...existing];
  const duplicates: AttachmentMergeResult['duplicates'] = [];
  for (const candidate of incoming) {
    const match = merged.find((attachment) => isSameAttachment(attachment, candidate));
    if (match) duplicates.push({ incoming: candidate, existing: match });
    else merged.push(candidate);
  }
  return { attachments: merged.slice(0, cap), skippedCount: duplicates.length, duplicates };
}
