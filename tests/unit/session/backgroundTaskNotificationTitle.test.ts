import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTaskManager } from '../../../src/host/session/backgroundTaskManager';
import { isPlaceholderSessionTitle } from '../../../src/shared/sessionTitlePlaceholder';

const { sessionManager, notifyTaskComplete } = vi.hoisted(() => ({
  sessionManager: { getSession: vi.fn(), getSessionTitle: vi.fn(), getMessages: vi.fn() },
  notifyTaskComplete: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManager,
  notificationService: { notifyTaskComplete },
}));

const sessionId = 'session-1';
const prompt = '逐条检查这份合同的付款条款和违约责任，写一份修改建议，保留每期金额和违约金上限。';
const draft = '逐条检查这份合同的付款条款和违约责任，写一份修改建议，保留每...';

async function failBackgroundTask(snapshot: string, cachedTitle: string): Promise<void> {
  const manager = new BackgroundTaskManager();
  sessionManager.getSession
    .mockResolvedValueOnce({ title: snapshot, messages: [] })
    .mockResolvedValueOnce({ title: cachedTitle, messages: [] });
  expect(await manager.moveToBackground(sessionId)).toBe(true);
  await manager.markFailed(sessionId, 'Provider auth failure');
}

describe('BackgroundTaskManager failure notification title', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionManager.getMessages.mockResolvedValue([]);
  });

  it('keeps the draft snapshot when the live title is 新对话', async () => {
    sessionManager.getSessionTitle.mockReturnValue('新对话');

    await failBackgroundTask(draft, '新对话');

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionTitle: draft, succeeded: false }),
      { force: true },
    );
  });

  it.each(['新对话', 'New conversation'])('names a %s task from the first user message on disk', async (placeholder) => {
    expect(isPlaceholderSessionTitle(placeholder)).toBe(true);
    sessionManager.getSessionTitle.mockReturnValue(placeholder);
    sessionManager.getMessages.mockResolvedValue([
      { role: 'assistant', content: 'Welcome' },
      { role: 'user', content: prompt },
      { role: 'user', content: 'A later request' },
    ]);

    await failBackgroundTask(placeholder, placeholder);

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionTitle: draft, succeeded: false }),
      { force: true },
    );
  });

  it('prefers a persisted smart title to the stale placeholder in the host cache', async () => {
    sessionManager.getSessionTitle.mockReturnValue('付款与违约条款审阅');

    await failBackgroundTask('新对话', '新对话');

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionTitle: '付款与违约条款审阅', succeeded: false }),
      { force: true },
    );
    expect(sessionManager.getMessages).not.toHaveBeenCalled();
  });

  it('continues to prefer a live smart title to a draft snapshot', async () => {
    sessionManager.getSessionTitle.mockReturnValue('付款与违约条款审阅');

    await failBackgroundTask(draft, '付款与违约条款审阅');

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionTitle: '付款与违约条款审阅', succeeded: false }),
      { force: true },
    );
  });

  it('keeps an existing real title', async () => {
    const title = 'Review the services contract';
    sessionManager.getSessionTitle.mockReturnValue(title);

    await failBackgroundTask(title, title);

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionTitle: title, succeeded: false }),
      { force: true },
    );
  });

  it('keeps the current placeholder when there is no title or user message to use', async () => {
    await failBackgroundTask('新对话', 'New conversation');

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionTitle: 'New conversation', succeeded: false }),
      { force: true },
    );
  });
});
