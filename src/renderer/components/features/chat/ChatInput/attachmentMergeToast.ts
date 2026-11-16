import { toast, useToastStore } from '../../../../hooks/useToast';
import type { AttachmentMergeResult } from './attachmentDedupe';

interface AttachmentMergeCopy {
  attachmentAlreadyAdded: string;
  attachmentAlreadyAddedMany: string;
  attachmentLimitReached: string;
  attachmentLimitReachedNone: string;
}

// 同一时刻最多一条「附件已满」提示：新的出现前先撤掉旧的，旧数字不会和新数字并存。
let limitToastId: string | null = null;

export function dismissAttachmentLimitToast(): void {
  if (limitToastId === null) return;
  useToastStore.getState().removeToast(limitToastId);
  limitToastId = null;
}

export function notifyAttachmentMerge(
  result: AttachmentMergeResult,
  copy: AttachmentMergeCopy,
): void {
  if (result.skippedCount > 0) {
    const duplicateName = result.duplicates[0]?.incoming.name ?? '';
    const template = result.skippedCount > 1 ? copy.attachmentAlreadyAddedMany : copy.attachmentAlreadyAdded;
    toast.show(
      'warning',
      template.replace('{name}', duplicateName).replace('{count}', String(result.skippedCount)),
    );
  }
  if (result.overflowCount > 0) {
    const template = result.addedCount > 0 ? copy.attachmentLimitReached : copy.attachmentLimitReachedNone;
    dismissAttachmentLimitToast();
    limitToastId = toast.show(
      'warning',
      template
        .replace('{added}', String(result.addedCount))
        .replace('{dropped}', String(result.overflowCount))
        .replace('{max}', String(result.cap)),
    );
  }
}
