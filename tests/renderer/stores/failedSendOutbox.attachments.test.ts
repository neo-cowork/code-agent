// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageAttachment } from '../../../src/shared/contract';
import { isImageAttachmentMissingData } from '../../../src/shared/utils/messageAttachments';
import { languages } from '../../../src/renderer/i18n';
import { failedSendAttachmentTurnCardEn, failedSendAttachmentTurnCardZh } from '../../../src/renderer/i18n/failedSendAttachment';

const SESSION = 'session-outbox-attach';
// 超过 localStorage 配额（jsdom 默认 5MB 内）的真实截图量级：6MB data URL。
const bigDataUrl = `data:image/png;base64,${'A'.repeat(6 * 1024 * 1024)}`;

function image(id: string, name: string): MessageAttachment {
  return { id, type: 'image', category: 'image', name, size: 6_000_000, mimeType: 'image/png', data: bigDataUrl, thumbnail: bigDataUrl };
}

function turn(content: string, attachments: MessageAttachment[]): { user: Message; error: Message } {
  const user: Message = { id: 'u1', role: 'user', content, timestamp: 100, attachments };
  const error: Message = {
    id: 'e1', role: 'assistant', content: '这个项目文件夹需要你确认后 Neo 才能使用。', timestamp: 101,
    metadata: { retryPrompt: content, retryClientMessageId: 'u1', retrySessionId: SESSION, retryAttachments: attachments },
  };
  return { user, error };
}

// 模拟「刷新页面」：丢掉模块内存缓存，只留 localStorage，再走生产入口 mergeFailedSendOutbox。
async function reloadAndMerge(): Promise<Message[]> {
  vi.resetModules();
  const mod = await import('../../../src/renderer/stores/failedSendOutbox');
  return mod.mergeFailedSendOutbox(SESSION, [], []);
}

describe('failed send outbox keeps attachments across a page refresh', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it.each([
    ['image only', '', [image('a1', '01-landing.png')]],
    ['image + text', '这是附件图片，请只回复：附件消息已收到', [image('a1', '01-landing.png')]],
    ['multiple images', '三张图', [image('a1', '01-landing.png'), image('a2', '02-pricing.png'), image('a3', '03-footer.png')]],
  ])('%s', async (_label, content, attachments) => {
    const { recordFailedSend } = await import('../../../src/renderer/stores/failedSendOutbox');
    const { user, error } = turn(content, attachments);
    recordFailedSend(SESSION, user, error);

    const restored = await reloadAndMerge();
    const restoredUser = restored.find((message) => message.role === 'user');
    expect(restoredUser?.content).toBe(content);
    expect(restoredUser?.attachments?.map((attachment) => attachment.name)).toEqual(attachments.map((attachment) => attachment.name));
    expect(restoredUser?.metadata?.sendFailed).toBe(true);
  });

  it('keeps pdf and csv attachments untouched', async () => {
    const pdf: MessageAttachment = { id: 'p1', type: 'file', category: 'pdf', name: 'report.pdf', size: 10, mimeType: 'application/pdf', pageCount: 3 };
    const csv: MessageAttachment = { id: 'c1', type: 'file', category: 'excel', name: 'data.csv', size: 10, mimeType: 'text/csv', rowCount: 12 };
    const { recordFailedSend } = await import('../../../src/renderer/stores/failedSendOutbox');
    const { user, error } = turn('看下这两个文件', [pdf, csv]);
    recordFailedSend(SESSION, user, error);

    const restoredUser = (await reloadAndMerge()).find((message) => message.role === 'user');
    expect(restoredUser?.attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'report.pdf', pageCount: 3 }),
      expect.objectContaining({ name: 'data.csv', rowCount: 12 }),
    ]));
  });

  it('keeps full image data when it exceeds 512K chars but still fits the quota', async () => {
    const mid = `data:image/png;base64,${'B'.repeat(900 * 1024)}`;
    const att: MessageAttachment = { id: 'm1', type: 'image', category: 'image', name: 'mid.png', size: 700_000, mimeType: 'image/png', data: mid };
    const { recordFailedSend } = await import('../../../src/renderer/stores/failedSendOutbox');
    const { user, error } = turn('', [att]);
    recordFailedSend(SESSION, user, error);

    const restoredUser = (await reloadAndMerge()).find((message) => message.role === 'user');
    expect(restoredUser?.attachments?.[0]?.data).toBe(mid);
  });

  it('marks over-quota 6MB image without path as missing data after reload', async () => {
    const { recordFailedSend } = await import('../../../src/renderer/stores/failedSendOutbox');
    const { user, error } = turn('check this screenshot and summarize it', [image('a1', '01-landing.png')]);
    recordFailedSend(SESSION, user, error);

    const restored = await reloadAndMerge();
    const restoredUser = restored.find((message) => message.role === 'user');
    const restoredAtt = restoredUser?.attachments?.[0];
    expect(restoredAtt?.data).toBeUndefined();
    expect(restoredAtt?.path).toBeUndefined();
    expect(restoredAtt && isImageAttachmentMissingData(restoredAtt)).toBe(true);
  });

  it.each(['zh', 'en'] as const)('blocks regenerateMessage when an over-quota image lost its bytes, restores composer with intact attachments, and toasts in %s', async (language) => {
    const pdf: MessageAttachment = { id: 'p1', type: 'file', category: 'pdf', name: 'report.pdf', size: 10, mimeType: 'application/pdf', pageCount: 3 };
    const { recordFailedSend } = await import('../../../src/renderer/stores/failedSendOutbox');
    const { user, error } = turn('check this screenshot and summarize it', [image('a1', '01-landing.png'), pdf]);
    recordFailedSend(SESSION, user, error);

    const restored = await reloadAndMerge();
    const { useAppStore } = await import('../../../src/renderer/stores/appStore');
    const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    const { useMessageActionStore } = await import('../../../src/renderer/stores/messageActionStore');
    const { useToastStore } = await import('../../../src/renderer/hooks/useToast');

    useAppStore.setState({ language });
    useSessionStore.setState({ currentSessionId: SESSION, runningSessionIds: new Set() } as never);
    useToastStore.setState({ toasts: [] });
    const send = vi.fn();
    const restoreComposer = vi.fn();
    useMessageActionStore.getState().register(send, () => restored, restoreComposer);

    const sent = useMessageActionStore.getState().regenerateMessage('e1');

    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(restoreComposer).toHaveBeenCalledExactlyOnceWith({
      content: 'check this screenshot and summarize it',
      attachments: [expect.objectContaining({ id: 'p1', name: 'report.pdf', pageCount: 3 })],
      clientMessageId: 'u1',
    });
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: languages[language].turnCard.failedImageDataLost,
      }),
    );
  });

  it('blocks regenerateMessage on anchor-only retryAttachments and sendFailed backward-scan branches, while leaving non-failed regenerate unchanged', async () => {
    const { useAppStore } = await import('../../../src/renderer/stores/appStore');
    const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    const { useMessageActionStore } = await import('../../../src/renderer/stores/messageActionStore');
    const { useToastStore } = await import('../../../src/renderer/hooks/useToast');

    useAppStore.setState({ language: 'zh' });
    useSessionStore.setState({ currentSessionId: SESSION, runningSessionIds: new Set() } as never);
    const missingImg: MessageAttachment = { id: 'a-lost', type: 'image', category: 'image', name: 'big.png', size: 6_000_000, mimeType: 'image/png' };

    // Anchor-only branch (no live user message on timeline)
    const send1 = vi.fn();
    const restore1 = vi.fn();
    useToastStore.setState({ toasts: [] });
    useMessageActionStore.getState().register(send1, () => [
      {
        id: 'e-anchor', role: 'assistant', content: '失败', timestamp: 2,
        metadata: { retryPrompt: '看下截图', retryAttachments: [missingImg], retryClientMessageId: 'u-gone', retrySessionId: SESSION },
      },
    ], restore1);
    expect(useMessageActionStore.getState().regenerateMessage('e-anchor')).toBe(false);
    expect(send1).not.toHaveBeenCalled();
    expect(restore1).toHaveBeenCalledExactlyOnceWith({ content: '看下截图', attachments: [], clientMessageId: 'u-gone' });
    expect(useToastStore.getState().toasts).toHaveLength(1);

    // sendFailed backward-scan branch (no retry anchor on assistant error)
    const send2 = vi.fn();
    const restore2 = vi.fn();
    useToastStore.setState({ toasts: [] });
    useMessageActionStore.getState().register(send2, () => [
      { id: 'u-scan', role: 'user', content: '帮我分析这张图', timestamp: 1, attachments: [missingImg], metadata: { sendFailed: true } },
      { id: 'e-scan', role: 'assistant', content: '失败', timestamp: 2 },
    ], restore2);
    expect(useMessageActionStore.getState().regenerateMessage('e-scan')).toBe(false);
    expect(send2).not.toHaveBeenCalled();
    expect(restore2).toHaveBeenCalledExactlyOnceWith({ content: '帮我分析这张图', attachments: [], clientMessageId: 'u-scan' });
    expect(useToastStore.getState().toasts).toHaveLength(1);

    // Non-failed regenerate (already persisted normal turn whose image has no data/path) must still send
    const send3 = vi.fn();
    const restore3 = vi.fn();
    useToastStore.setState({ toasts: [] });
    useMessageActionStore.getState().register(send3, () => [
      { id: 'u-ok', role: 'user', content: '重新总结', timestamp: 1, attachments: [missingImg] },
      { id: 'a-ok', role: 'assistant', content: '之前的回复', timestamp: 2 },
    ], restore3);
    expect(useMessageActionStore.getState().regenerateMessage('a-ok')).toBe(true);
    expect(send3).toHaveBeenCalledExactlyOnceWith('重新总结', { attachments: [missingImg] });
    expect(restore3).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('still resends mid-size image (data kept), big image with surviving path, and pdf/csv attachments', async () => {
    const midData = `data:image/png;base64,${'B'.repeat(900 * 1024)}`;
    const midImg: MessageAttachment = { id: 'm1', type: 'image', category: 'image', name: 'mid.png', size: 700_000, mimeType: 'image/png', data: midData };
    const bigWithPath: MessageAttachment = { ...image('p-img', 'big-on-disk.png'), path: '/workspace/uploads/big-on-disk.png' };
    const pdf: MessageAttachment = { id: 'p1', type: 'file', category: 'pdf', name: 'report.pdf', size: 10, mimeType: 'application/pdf', pageCount: 3 };
    const csv: MessageAttachment = { id: 'c1', type: 'file', category: 'excel', name: 'data.csv', size: 10, mimeType: 'text/csv', rowCount: 12 };

    const cases: Array<[string, MessageAttachment[]]> = [
      ['mid image', [midImg]],
      ['big image with path', [bigWithPath]],
      ['pdf and csv', [pdf, csv]],
    ];

    for (const [label, atts] of cases) {
      localStorage.clear();
      vi.resetModules();
      const { recordFailedSend } = await import('../../../src/renderer/stores/failedSendOutbox');
      const { user, error } = turn(`case: ${label}`, atts);
      recordFailedSend(SESSION, user, error);

      const restored = await reloadAndMerge();
      const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
      const { useMessageActionStore } = await import('../../../src/renderer/stores/messageActionStore');
      useSessionStore.setState({ currentSessionId: SESSION, runningSessionIds: new Set() } as never);
      const send = vi.fn();
      const restoreComposer = vi.fn();
      useMessageActionStore.getState().register(send, () => restored, restoreComposer);

      const sent = useMessageActionStore.getState().regenerateMessage('e1');
      expect(sent, label).toBe(true);
      expect(send, label).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0], label).toBe(`case: ${label}`);
      expect(send.mock.calls[0]?.[1]?.attachments?.map((a: MessageAttachment) => a.name), label).toEqual(atts.map((a) => a.name));
      if (label === 'mid image') {
        expect(send.mock.calls[0]?.[1]?.attachments?.[0]?.data).toBe(midData);
      }
      if (label === 'big image with path') {
        expect(send.mock.calls[0]?.[1]?.attachments?.[0]?.path).toBe('/workspace/uploads/big-on-disk.png');
        expect(isImageAttachmentMissingData(send.mock.calls[0]?.[1]?.attachments?.[0])).toBe(false);
      }
      expect(restoreComposer, label).not.toHaveBeenCalled();
    }
  });

  it('keeps zh and en failed-attachment copy key sets symmetric', () => {
    expect(Object.keys(failedSendAttachmentTurnCardZh).sort()).toEqual(
      Object.keys(failedSendAttachmentTurnCardEn).sort(),
    );
    expect(languages.zh.turnCard.failedImageDataLost).toBeTruthy();
    expect(languages.en.turnCard.failedImageDataLost).toBeTruthy();
  });
});
