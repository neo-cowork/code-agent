import { toast } from '../../../../hooks/useToast';
import { useComposerAttachmentLimitStore } from '../../../../stores/composerAttachmentLimitStore';
import type { AttachmentMergeResult } from './attachmentDedupe';

interface AttachmentMergeCopy {
  attachmentAlreadyAdded: string;
  attachmentAlreadyAddedMany: string;
}

// 「附件已满」不再走全局 toast（fixed 悬浮层会盖住输入框），改写输入框上方的单槽提示。
export function dismissAttachmentLimitToast(): void {
  useComposerAttachmentLimitStore.getState().clear();
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
    useComposerAttachmentLimitStore.getState().show({
      added: result.addedCount,
      dropped: result.overflowCount,
      max: result.cap,
      kind: result.addedCount > 0 ? 'partial' : 'none',
    });
  }
}
