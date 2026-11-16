// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI } from '../../../../src/shared/constants';
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
    vi.useFakeTimers();
    dismissAttachmentLimitToast();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    dismissAttachmentLimitToast();
    useToastStore.setState({ toasts: [] });
  });

  it('stays visible after five minutes until explicitly dismissed', () => {
    notifyAttachmentMerge(overflow(10, 10), zh.chatInput);
    const id = toasts()[0].id;
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(toasts().map((t) => t.id)).toEqual([id]);
    expect(toasts()[0].duration).toBe(UI.TOAST_PERSISTENT_DURATION);
    dismissAttachmentLimitToast();
    expect(toasts()).toHaveLength(0);
  });

  it('can be manually closed and replaced after closing', () => {
    notifyAttachmentMerge(overflow(10, 10), zh.chatInput);
    useToastStore.getState().removeToast(toasts()[0].id);
    expect(toasts()).toHaveLength(0);
    notifyAttachmentMerge(overflow(0, 5), zh.chatInput);
    expect(toasts()).toHaveLength(1);
    dismissAttachmentLimitToast();
    dismissAttachmentLimitToast();
    expect(toasts()).toHaveLength(0);
  });

  it('keeps exactly one limit toast, the newer one, across consecutive overflows', () => {
    notifyAttachmentMerge(overflow(10, 20), zh.chatInput);
    const oldId = toasts()[0].id;
    vi.advanceTimersByTime(60 * 1000);
    notifyAttachmentMerge(overflow(0, 5), zh.chatInput);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].id).not.toBe(oldId);
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
