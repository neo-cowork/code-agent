import { toast, useToastStore } from '../../../../hooks/useToast';
import { useComposerAttachmentLimitStore } from '../../../../stores/composerAttachmentLimitStore';
import type { AttachmentMergeResult } from './attachmentDedupe';

interface AttachmentMergeCopy {
  attachmentAlreadyAdded: string;
  attachmentAlreadyAddedMany: string;
}

// 重复附件警告走全局 toast，addToast 只追加不替换，连续重复添加会堆叠（FB-1745）。
// 记住最后一条的 id：下一次弹出前先移除旧的，且发送 / 切会话 / 移除附件时随
// dismissAttachmentLimitToast 一并清掉（先例 osNotification.ts 的 lastFallbackToastId）。
let lastDuplicateToastId: string | null = null;

// 清掉「附件已满」单槽提示和重复附件的全局警告 toast。
export function dismissAttachmentLimitToast(): void {
  useComposerAttachmentLimitStore.getState().clear();
  if (lastDuplicateToastId !== null) {
    useToastStore.getState().removeToast(lastDuplicateToastId);
    lastDuplicateToastId = null;
  }
}

export function notifyAttachmentMerge(
  result: AttachmentMergeResult,
  copy: AttachmentMergeCopy,
): void {
  if (result.skippedCount > 0) {
    if (lastDuplicateToastId !== null) useToastStore.getState().removeToast(lastDuplicateToastId);
    const duplicateName = result.duplicates[0]?.incoming.name ?? '';
    const template = result.skippedCount > 1 ? copy.attachmentAlreadyAddedMany : copy.attachmentAlreadyAdded;
    lastDuplicateToastId = toast.show(
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
