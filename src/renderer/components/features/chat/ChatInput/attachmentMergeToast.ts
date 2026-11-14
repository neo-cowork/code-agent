import { toast } from '../../../../hooks/useToast';
import type { AttachmentMergeResult } from './attachmentDedupe';

interface AttachmentMergeCopy {
  attachmentAlreadyAdded: string;
  attachmentLimitReached: string;
}

export function notifyAttachmentMerge(
  result: AttachmentMergeResult,
  copy: AttachmentMergeCopy,
): void {
  if (result.skippedCount > 0) {
    const duplicateName = result.duplicates[0]?.incoming.name ?? '';
    toast.show('warning', copy.attachmentAlreadyAdded.replace('{name}', duplicateName));
  }
  if (result.overflowCount > 0) {
    toast.show(
      'warning',
      copy.attachmentLimitReached
        .replace('{added}', String(result.addedCount))
        .replace('{dropped}', String(result.overflowCount))
        .replace('{max}', String(result.cap)),
    );
  }
}
