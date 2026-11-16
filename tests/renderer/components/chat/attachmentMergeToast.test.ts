// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useToastStore } from '../../../../src/renderer/hooks/useToast';
import {
  dismissAttachmentLimitToast,
  notifyAttachmentMerge,
} from '../../../../src/renderer/components/features/chat/ChatInput/attachmentMergeToast';
import type { AttachmentMergeResult } from '../../../../src/renderer/components/features/chat/ChatInput/attachmentDedupe';
import { zh } from '../../../../src/renderer/i18n/zh';
import { en } from '../../../../src/renderer/i18n/en';

function overflow(added: number, dropped: number): AttachmentMergeResult {
  return {
    attachments: [],
    addedCount: added,
    overflowCount: dropped,
    skippedCount: 0,
    duplicates: [],
    cap: 10,
  } as unknown as AttachmentMergeResult;
}

const toasts = () => useToastStore.getState().toasts;

describe('notifyAttachmentMerge limit toast', () => {
  beforeEach(() => {
    dismissAttachmentLimitToast();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    dismissAttachmentLimitToast();
    useToastStore.setState({ toasts: [] });
  });

  it('keeps exactly one limit toast, the newer one, across consecutive overflows', () => {
    notifyAttachmentMerge(overflow(10, 20), zh.chatInput);
    notifyAttachmentMerge(overflow(0, 5), zh.chatInput);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toContain('5 个都没加进来');
  });

  it('is idempotent when fired twice with identical input (updater double-invoke)', () => {
    notifyAttachmentMerge(overflow(3, 7), zh.chatInput);
    notifyAttachmentMerge(overflow(3, 7), zh.chatInput);
    expect(toasts()).toHaveLength(1);
  });

  it.each([
    ['zh', zh.chatInput, ['10 个', '加进了 3 个', '另 7 个', '发送这条消息后']],
    ['en', en.chatInput, ['(10)', '3 added', '7 more', 'after sending this message']],
  ] as const)('copy states limit, added, not-added and next step (%s)', (_l, copy, parts) => {
    notifyAttachmentMerge(overflow(3, 7), copy);
    for (const part of parts) expect(toasts()[0].message).toContain(part);
  });

  it('reads naturally when none were added (zh and en)', () => {
    notifyAttachmentMerge(overflow(0, 4), zh.chatInput);
    expect(toasts()[0].message).toContain('没有加进任何文件');
    expect(toasts()[0].message).not.toContain('{');
    notifyAttachmentMerge(overflow(0, 4), en.chatInput);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toContain('none were added this time');
  });

  it('dismiss removes the limit toast but leaves other toasts', () => {
    useToastStore.getState().addToast('info', 'other', 0);
    notifyAttachmentMerge(overflow(10, 20), zh.chatInput);
    expect(toasts()).toHaveLength(2);
    dismissAttachmentLimitToast();
    expect(toasts().map((t) => t.message)).toEqual(['other']);
  });
});
