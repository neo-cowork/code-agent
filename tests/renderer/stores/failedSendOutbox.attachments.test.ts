// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageAttachment } from '../../../src/shared/contract';

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
});
