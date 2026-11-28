import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLISessionManager } from '../../../src/cli/session';
import { BackgroundTaskManager } from '../../../src/host/session/backgroundTaskManager';
import { BACKGROUND_NOTIFICATION_TIMEOUTS } from '../../../src/shared/constants';
import type { Message, Session } from '../../../src/shared/contract';
import { buildSessionTitle, isPlaceholderSessionTitle } from '../../../src/shared/sessionTitlePlaceholder';

const { sessionManager, notifyTaskComplete, loggerMocks, quickModelState } = vi.hoisted(() => ({
  sessionManager: { getSession: vi.fn(), getSessionTitle: vi.fn(), getMessages: vi.fn() },
  notifyTaskComplete: vi.fn(),
  loggerMocks: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  quickModelState: {
    available: false,
    delayMs: null as number | null,
    reply: '',
    resolvers: [] as Array<(value: { success: boolean; content: string }) => void>,
  },
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManager,
  notificationService: { notifyTaskComplete },
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: loggerMocks,
  createLogger: () => loggerMocks,
}));

vi.mock('../../../src/host/model/quickModel', () => ({
  isQuickModelAvailable: () => quickModelState.available,
  quickTask: () => new Promise<{ success: boolean; content: string }>((resolve) => {
    if (quickModelState.delayMs !== null) {
      setTimeout(() => {
        resolve({ success: true, content: quickModelState.reply });
      }, quickModelState.delayMs);
      return;
    }
    quickModelState.resolvers.push(resolve);
  }),
}));

vi.mock('../../../src/cli/bootstrap', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'en' } }) }),
}));

vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ updateSessionTitle: () => undefined }),
}));

vi.mock('../../../src/host/services/infra/sessionTitleCloudPush', () => ({
  pushSessionTitleToCloud: () => undefined,
}));

vi.mock('../../../src/host/platform/windowBridge', () => ({
  broadcastToRenderer: () => undefined,
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

describe('BackgroundTaskManager pending session title wait', () => {
  const enPrompt = 'Go through the payment terms and the breach-of-contract clauses in this contract one by one, and write up suggested revisions.';
  const enDraft = buildSessionTitle(enPrompt);
  const enSmartTitle = 'Contract payment and breach clause revisions';

  function createInMemoryCliSession(sid: string, initialTitle: string): {
    cliManager: CLISessionManager;
    getStoredTitle: () => string;
  } {
    const sessions = new Map<string, Session>();
    const messages = new Map<string, Message[]>();
    const cliManager = new CLISessionManager();
    const fakeDb = {
      isInitialized: true,
      createSession: (session: Session) => {
        sessions.set(session.id, { ...session });
      },
      getSession: (id: string) => {
        const stored = sessions.get(id);
        return stored ? { ...stored } : null;
      },
      addMessage: (id: string, message: Message) => {
        const list = messages.get(id) ?? [];
        list.push(message);
        messages.set(id, list);
      },
      getMessagesForLoad: (id: string) => [...(messages.get(id) ?? [])],
      getTodos: () => [],
      updateSession: (id: string, updates: Partial<Session>) => {
        const existing = sessions.get(id);
        if (existing) {
          sessions.set(id, { ...existing, ...updates });
        }
      },
    };
    Object.assign(cliManager as unknown as Record<string, unknown>, {
      _dbChecked: true,
      _db: fakeDb,
    });

    sessionManager.getSession.mockImplementation(async (id: string) => {
      const stored = sessions.get(id);
      return stored ? { ...stored, messages: messages.get(id) ?? [] } : null;
    });
    sessionManager.getSessionTitle.mockImplementation((id: string) => sessions.get(id)?.title);
    sessionManager.getMessages.mockImplementation(async (id: string) => [...(messages.get(id) ?? [])]);

    // Seed session with the initial draft/existing title when needed
    if (initialTitle) {
      fakeDb.createSession({
        id: sid,
        title: initialTitle,
        modelConfig: { provider: 'openai', model: 'test-model' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return {
      cliManager,
      getStoredTitle: () => sessions.get(sid)?.title ?? '',
    };
  }

  async function addFirstUserMessage(cliManager: CLISessionManager, sid: string, title: string): Promise<void> {
    await cliManager.addMessageToSession(
      sid,
      {
        id: `msg-${sid}-1`,
        role: 'user',
        content: enPrompt,
        timestamp: Date.now(),
      },
      {
        title,
        modelConfig: { provider: 'openai', model: 'test-model' },
      },
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    quickModelState.available = true;
    quickModelState.delayMs = null;
    quickModelState.reply = '';
    quickModelState.resolvers = [];
    sessionManager.getMessages.mockResolvedValue([]);
  });

  afterEach(async () => {
    for (const resolve of quickModelState.resolvers.splice(0)) {
      resolve({ success: false, content: '' });
    }
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it('(a) waits for pending CLI addMessageToSession title job on markFailed and uses the new name', async () => {
    const sid = 'pending-fail-settled';
    quickModelState.delayMs = 8_000;
    quickModelState.reply = enSmartTitle;

    const { cliManager } = createInMemoryCliSession(sid, enDraft);
    await addFirstUserMessage(cliManager, sid, enDraft);

    const bgManager = new BackgroundTaskManager();
    const updates: string[] = [];
    bgManager.on('update', (event: { type: string }) => updates.push(event.type));

    expect(await bgManager.moveToBackground(sid)).toBe(true);
    const failPromise = bgManager.markFailed(sid, 'Provider auth failure');

    // Panel row flips to failed immediately; OS banner waits for the pending title job.
    expect(updates).toEqual(['added', 'failed']);
    expect(notifyTaskComplete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(8_000);
    await failPromise;

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: sid, sessionTitle: enSmartTitle, succeeded: false }),
      { force: true },
    );
    expect(loggerMocks.info).toHaveBeenCalledWith(
      'Waited for pending session title before notification',
      expect.objectContaining({ sessionId: sid, waitedMs: expect.any(Number) }),
    );
  });

  it('(b) notifies immediately without advancing time when no title job is pending on markFailed', async () => {
    const sid = 'no-pending-fail';
    const existingTitle = 'Quarterly financial summary';
    createInMemoryCliSession(sid, existingTitle);

    const bgManager = new BackgroundTaskManager();
    expect(await bgManager.moveToBackground(sid)).toBe(true);
    await bgManager.markFailed(sid, 'Provider auth failure');

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: sid, sessionTitle: existingTitle, succeeded: false }),
      { force: true },
    );
    expect(loggerMocks.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
      expect.anything(),
    );
    expect(loggerMocks.info).not.toHaveBeenCalledWith(
      'Waited for pending session title before notification',
      expect.anything(),
    );
  });

  it('(c) notifies at the bound with then-current title and logs warn when title job outlives bound on markFailed', async () => {
    const sid = 'pending-fail-timeout';
    quickModelState.delayMs = null; // Held open past the timeout bound.

    const { cliManager } = createInMemoryCliSession(sid, enDraft);
    await addFirstUserMessage(cliManager, sid, enDraft);

    const bgManager = new BackgroundTaskManager();
    expect(await bgManager.moveToBackground(sid)).toBe(true);
    const failPromise = bgManager.markFailed(sid, 'Provider auth failure');

    await vi.advanceTimersByTimeAsync(BACKGROUND_NOTIFICATION_TIMEOUTS.TITLE_WAIT_MS - 1);
    expect(notifyTaskComplete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await failPromise;

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: sid, sessionTitle: enDraft, succeeded: false }),
      { force: true },
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'Pending session title wait timed out before notification',
      expect.objectContaining({
        reason: 'title_wait_timeout',
        sessionId: sid,
        timeoutMs: BACKGROUND_NOTIFICATION_TIMEOUTS.TITLE_WAIT_MS,
      }),
    );
  });

  it('(d) suppresses notification when moved to foreground during the title wait on markFailed', async () => {
    const sid = 'pending-fail-foreground';
    quickModelState.delayMs = 8_000;
    quickModelState.reply = enSmartTitle;

    const { cliManager } = createInMemoryCliSession(sid, enDraft);
    await addFirstUserMessage(cliManager, sid, enDraft);

    const bgManager = new BackgroundTaskManager();
    expect(await bgManager.moveToBackground(sid)).toBe(true);
    const failPromise = bgManager.markFailed(sid, 'Provider auth failure');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(bgManager.moveToForeground(sid)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(8_000);
    await failPromise;

    expect(notifyTaskComplete).not.toHaveBeenCalled();
  });

  it('(e1) waits for pending title job on markCompleted and uses the new name', async () => {
    const sid = 'pending-complete-settled';
    quickModelState.delayMs = 5_000;
    quickModelState.reply = enSmartTitle;

    const { cliManager } = createInMemoryCliSession(sid, enDraft);
    await addFirstUserMessage(cliManager, sid, enDraft);

    const bgManager = new BackgroundTaskManager();
    const updates: string[] = [];
    bgManager.on('update', (event: { type: string }) => updates.push(event.type));

    expect(await bgManager.moveToBackground(sid)).toBe(true);
    const completePromise = bgManager.markCompleted(sid, 'All clauses reviewed');

    expect(updates).toEqual(['added', 'completed']);
    expect(notifyTaskComplete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await completePromise;

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: sid, sessionTitle: enSmartTitle }),
      { force: true },
    );
    expect(loggerMocks.info).toHaveBeenCalledWith(
      'Waited for pending session title before notification',
      expect.objectContaining({ sessionId: sid, waitedMs: expect.any(Number) }),
    );
  });

  it('(e2) notifies immediately without advancing time when no title job is pending on markCompleted', async () => {
    const sid = 'no-pending-complete';
    const existingTitle = 'Quarterly financial summary';
    createInMemoryCliSession(sid, existingTitle);

    const bgManager = new BackgroundTaskManager();
    expect(await bgManager.moveToBackground(sid)).toBe(true);
    await bgManager.markCompleted(sid, 'Done');

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: sid, sessionTitle: existingTitle }),
      { force: true },
    );
  });

  it('(e3) notifies at the bound with then-current title and logs warn when title job outlives bound on markCompleted', async () => {
    const sid = 'pending-complete-timeout';
    quickModelState.delayMs = null;

    const { cliManager } = createInMemoryCliSession(sid, enDraft);
    await addFirstUserMessage(cliManager, sid, enDraft);

    const bgManager = new BackgroundTaskManager();
    expect(await bgManager.moveToBackground(sid)).toBe(true);
    const completePromise = bgManager.markCompleted(sid, 'Done');

    await vi.advanceTimersByTimeAsync(BACKGROUND_NOTIFICATION_TIMEOUTS.TITLE_WAIT_MS - 1);
    expect(notifyTaskComplete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await completePromise;

    expect(notifyTaskComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: sid, sessionTitle: enDraft }),
      { force: true },
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'Pending session title wait timed out before notification',
      expect.objectContaining({
        reason: 'title_wait_timeout',
        sessionId: sid,
        timeoutMs: BACKGROUND_NOTIFICATION_TIMEOUTS.TITLE_WAIT_MS,
      }),
    );
  });

  it('(e4) suppresses notification when moved to foreground during the title wait on markCompleted', async () => {
    const sid = 'pending-complete-foreground';
    quickModelState.delayMs = 5_000;
    quickModelState.reply = enSmartTitle;

    const { cliManager } = createInMemoryCliSession(sid, enDraft);
    await addFirstUserMessage(cliManager, sid, enDraft);

    const bgManager = new BackgroundTaskManager();
    expect(await bgManager.moveToBackground(sid)).toBe(true);
    const completePromise = bgManager.markCompleted(sid, 'Done');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(bgManager.moveToForeground(sid)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);
    await completePromise;

    expect(notifyTaskComplete).not.toHaveBeenCalled();
  });
});
