import type { MessageAttachment } from '@shared/contract';

export interface AttachmentMergeResult {
  attachments: MessageAttachment[];
  addedCount: number;
  overflowCount: number;
  skippedCount: number;
  duplicates: Array<{ incoming: MessageAttachment; existing: MessageAttachment }>;
  cap: number;
}

function isSameAttachment(a: MessageAttachment, b: MessageAttachment): boolean {
  if (a.path && b.path && a.path === b.path) return true;
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
  const attachments = merged.slice(0, cap);
  const uniqueIncomingCount = merged.length - existing.length;
  const existingKeptCount = Math.min(existing.length, attachments.length);
  const addedCount = attachments.length - existingKeptCount;
  const overflowCount = uniqueIncomingCount - addedCount;
  return {
    attachments,
    addedCount,
    overflowCount,
    skippedCount: duplicates.length,
    duplicates,
    cap,
  };
}
