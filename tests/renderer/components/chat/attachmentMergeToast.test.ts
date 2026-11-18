// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const useI18nMock = vi.hoisted(() => ({ lang: 'zh' as 'zh' | 'en' }));
vi.mock('../../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../../src/renderer/i18n/zh');
  const { en } = await import('../../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: useI18nMock.lang === 'zh' ? zh : en }) };
});
import { useToastStore } from '../../../../src/renderer/hooks/useToast';
import {
  dismissAttachmentLimitToast,
  notifyAttachmentMerge,
} from '../../../../src/renderer/components/features/chat/ChatInput/attachmentMergeToast';
import { ComposerAttachmentLimitNotice } from '../../../../src/renderer/components/features/chat/ChatInput/ComposerAttachmentLimitNotice';
import { ToastContainer } from '../../../../src/renderer/components/Toast';
import { useComposerAttachmentLimitStore } from '../../../../src/renderer/stores/composerAttachmentLimitStore';
import { COMPOSER_SLOT_LAYER } from '../../../../src/renderer/stores/composerNoticeStore';
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

function duplicateResult(count: number, overflowCount = 0): AttachmentMergeResult {
  const duplicates = Array.from({ length: count }, (_, index) => {
    const attachment = { name: `读书笔记${String(index + 1).padStart(2, '0')}.txt` };
    return { incoming: attachment, existing: attachment };
  });
  return {
    attachments: [],
    addedCount: 0,
    overflowCount,
    skippedCount: count,
    duplicates,
    cap: 10,
  } as unknown as AttachmentMergeResult;
}

const toasts = () => useToastStore.getState().toasts;
const limitNotice = () => useComposerAttachmentLimitStore.getState().notice;

describe('notifyAttachmentMerge', () => {
  beforeEach(() => {
    useI18nMock.lang = 'zh';
    vi.useFakeTimers();
    dismissAttachmentLimitToast();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    dismissAttachmentLimitToast();
    useToastStore.setState({ toasts: [] });
  });

  it('overflow writes the composer notice and never the global toast container', () => {
    notifyAttachmentMerge(overflow(10, 10), zh.chatInput);
    expect(toasts()).toHaveLength(0);
    expect(limitNotice()).toEqual({ added: 10, dropped: 10, max: 10, kind: 'partial' });
  });

  it('renders the notice inline in the composer, outside the global toast container', () => {
    render(
      h('div', null, h(ToastContainer), h('div', { 'data-testid': 'composer' }, h(ComposerAttachmentLimitNotice))),
    );
    act(() => notifyAttachmentMerge(overflow(10, 10), zh.chatInput));
    const node = screen.getByTestId('composer-attachment-limit');
    expect(node.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('composer').contains(node)).toBe(true);
    expect(node.closest('.fixed')).toBeNull();
    expect(node.textContent).toContain('附件已满（10 个）');
    expect(node.textContent).not.toMatch(/\{(?:added|dropped|max)\}/);
  });

  it('is registered in the composer slot at layer 3', () => {
    expect(COMPOSER_SLOT_LAYER['attachment-limit']).toBe(3);
  });

  it('stays visible after five minutes until explicitly dismissed', () => {
    notifyAttachmentMerge(overflow(10, 10), zh.chatInput);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(limitNotice()).not.toBeNull();
    dismissAttachmentLimitToast();
    expect(limitNotice()).toBeNull();
  });

  it('can be manually closed with X, leaves no leftover node, and a new overflow shows again', () => {
    render(h(ComposerAttachmentLimitNotice));
    act(() => notifyAttachmentMerge(overflow(10, 10), zh.chatInput));
    fireEvent.click(screen.getByTestId('composer-attachment-limit-dismiss'));
    expect(screen.queryByTestId('composer-attachment-limit')).toBeNull();
    expect(limitNotice()).toBeNull();
    act(() => notifyAttachmentMerge(overflow(0, 5), zh.chatInput));
    expect(screen.getAllByTestId('composer-attachment-limit')).toHaveLength(1);
  });

  it('keeps exactly one notice, the newer one, across consecutive overflows (replaced not stacked)', () => {
    render(h(ComposerAttachmentLimitNotice));
    act(() => notifyAttachmentMerge(overflow(10, 20), zh.chatInput));
    vi.advanceTimersByTime(60 * 1000);
    act(() => notifyAttachmentMerge(overflow(0, 5), zh.chatInput));
    const nodes = screen.getAllByTestId('composer-attachment-limit');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toContain('5 个都没加进来');
    expect(nodes[0].textContent).not.toContain('20');
  });

  it('is idempotent when fired twice with identical input (updater double-invoke)', () => {
    render(h(ComposerAttachmentLimitNotice));
    act(() => {
      notifyAttachmentMerge(overflow(3, 7), zh.chatInput);
      notifyAttachmentMerge(overflow(3, 7), zh.chatInput);
    });
    expect(screen.getAllByTestId('composer-attachment-limit')).toHaveLength(1);
  });

  it.each([
    ['zh', zh.chatInput, ['10 个', '加进了 3 个', '另 7 个', '发送这条消息后']],
    ['en', en.chatInput, ['(10)', '3 added', '7 more', 'after sending this message']],
  ] as const)('copy states limit, added, not-added and next step (%s)', (_l, _copy, parts) => {
    useI18nMock.lang = _l;
    render(h(ComposerAttachmentLimitNotice));
    act(() => notifyAttachmentMerge(overflow(3, 7), _copy));
    const text = screen.getByTestId('composer-attachment-limit').textContent ?? '';
    for (const part of parts) expect(text).toContain(part);
  });

  it('reads naturally when none were added (zh and en)', () => {
    render(h(ComposerAttachmentLimitNotice));
    act(() => notifyAttachmentMerge(overflow(0, 4), zh.chatInput));
    expect(screen.getByTestId('composer-attachment-limit').textContent).toContain('没有加进任何文件');
    cleanup();
    useI18nMock.lang = 'en';
    render(h(ComposerAttachmentLimitNotice));
    act(() => notifyAttachmentMerge(overflow(0, 4), en.chatInput));
    const text = screen.getByTestId('composer-attachment-limit').textContent ?? '';
    expect(text).toContain('none were added this time');
    expect(text).not.toContain('{');
  });

  it('dismiss clears the limit notice but leaves other toasts', () => {
    useToastStore.getState().addToast('info', 'other', 0);
    notifyAttachmentMerge(overflow(10, 20), zh.chatInput);
    dismissAttachmentLimitToast();
    expect(limitNotice()).toBeNull();
    expect(toasts().map((t) => t.message)).toEqual(['other']);
  });

  it.each([
    [1, 'zh', zh.chatInput, '读书笔记01.txt 已添加，无需重复添加'],
    [2, 'zh', zh.chatInput, '读书笔记01.txt 等 2 个文件已添加，无需重复添加'],
    [10, 'zh', zh.chatInput, '读书笔记01.txt 等 10 个文件已添加，无需重复添加'],
    [1, 'en', en.chatInput, '读书笔记01.txt is already attached'],
    [2, 'en', en.chatInput, '2 files are already attached (including 读书笔记01.txt)'],
    [10, 'en', en.chatInput, '10 files are already attached (including 读书笔记01.txt)'],
  ] as const)('shows the right text for %s duplicate(s) (%s)', (count, _language, copy, expected) => {
    notifyAttachmentMerge(duplicateResult(count), copy);
    expect(toasts().map((toast) => toast.message)).toEqual([expected]);
    expect(toasts()[0].message).not.toMatch(/\{(?:name|count)\}/);
  });

  it('keeps the duplicate toast and the limit notice separate when both occur in one merge', () => {
    notifyAttachmentMerge(duplicateResult(10, 2), zh.chatInput);
    expect(toasts().map((toast) => toast.message)).toEqual([
      '读书笔记01.txt 等 10 个文件已添加，无需重复添加',
    ]);
    expect(limitNotice()).toEqual({ added: 0, dropped: 2, max: 10, kind: 'none' });
  });
});
