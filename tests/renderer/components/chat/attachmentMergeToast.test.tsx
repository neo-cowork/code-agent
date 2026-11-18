// @vitest-environment jsdom
// 「附件已满」内联条在 composer 槽位里的位置与生命周期（store 行为见 attachmentMergeToast.test.ts）。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});

import { ComposerSlot, SlotEntry } from '../../../../src/renderer/components/features/chat/ChatInput/ComposerSlot';
import { ComposerAttachmentLimitNotice } from '../../../../src/renderer/components/features/chat/ChatInput/ComposerAttachmentLimitNotice';
import { notifyAttachmentMerge } from '../../../../src/renderer/components/features/chat/ChatInput/attachmentMergeToast';
import type { AttachmentMergeResult } from '../../../../src/renderer/components/features/chat/ChatInput/attachmentDedupe';
import { useComposerAttachmentLimitStore } from '../../../../src/renderer/stores/composerAttachmentLimitStore';
import { zh } from '../../../../src/renderer/i18n/zh';

const overflow = {
  attachments: [], addedCount: 10, overflowCount: 10, skippedCount: 0, duplicates: [], cap: 10,
} as unknown as AttachmentMergeResult;

function Composer() {
  return (
    <form data-testid="composer-form">
      <ComposerSlot>
        <SlotEntry id="attachment-limit"><ComposerAttachmentLimitNotice /></SlotEntry>
      </ComposerSlot>
      <div data-testid="input-box">
        <div data-testid="attachment-chips">
          {Array.from({ length: 10 }, (_, i) => <span key={i} role="group">reading-note-{i + 1}.txt</span>)}
        </div>
        <textarea data-testid="composer-textarea" defaultValue="把这些读书笔记总结成一页。" />
      </div>
    </form>
  );
}

describe('attachment limit notice inside the composer slot', () => {
  beforeEach(() => useComposerAttachmentLimitStore.getState().clear());
  afterEach(() => { cleanup(); useComposerAttachmentLimitStore.getState().clear(); });

  it('appears in the slot above the input box, outside textarea and chips, in normal flow', () => {
    render(<Composer />);
    expect(screen.queryByTestId('composer-attachment-limit')).toBeNull();
    act(() => notifyAttachmentMerge(overflow, zh.chatInput));
    const notice = screen.getByTestId('composer-attachment-limit');
    const box = screen.getByTestId('input-box');
    expect(screen.getByTestId('composer-slot').contains(notice)).toBe(true);
    expect(box.contains(notice)).toBe(false);
    expect(screen.getByTestId('composer-textarea').contains(notice)).toBe(false);
    expect(screen.getByTestId('attachment-chips').contains(notice)).toBe(false);
    expect(notice.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.closest('.fixed, .absolute')).toBeNull();
    expect(getComputedStyle(notice).position).not.toBe('fixed');
    expect(screen.getAllByRole('group')).toHaveLength(10);
    expect((screen.getByTestId('composer-textarea') as HTMLTextAreaElement).value).toBe('把这些读书笔记总结成一页。');
  });

  it('is gone after the user dismisses it, leaving the input box untouched', () => {
    render(<Composer />);
    const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
    screen.getByTestId('composer-form').addEventListener('submit', submit as unknown as EventListener);
    act(() => notifyAttachmentMerge(overflow, zh.chatInput));
    fireEvent.click(screen.getByTestId('composer-attachment-limit-dismiss'));
    expect(submit).not.toHaveBeenCalled(); // X 在 composer <form> 里，不能触发发送
    expect(screen.queryByTestId('composer-attachment-limit')).toBeNull();
    expect(screen.getByTestId('composer-slot').children).toHaveLength(0);
    expect(screen.getAllByRole('group')).toHaveLength(10);
  });
});
