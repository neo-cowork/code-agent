// web 构建的标题落在 CLISessionManager.updateSession。落库成功后必须经 renderer 推送总线
// 广播 session:updated，侧栏才能在本轮还在跑时换掉临时标题。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Session } from '../../../src/shared/contract';
import { deriveRuleSummaryTitle } from '../../../src/shared/sessionTitlePlaceholder';
import { onRendererPush } from '../../../src/host/platform/windowBridge';

const quick = vi.hoisted(() => ({
  task: vi.fn<(prompt: string) => Promise<{ success: boolean; content?: string; error?: string }>>(
    async () => ({ success: false, error: 'empty' }),
  ),
}));

vi.mock('../../../src/host/model/quickModel', () => ({
  isQuickModelAvailable: () => true,
  quickTask: (prompt: string) => quick.task(prompt),
}));
vi.mock('../../../src/host/services/infra/sessionFolderName', () => ({
  initMemorySessionTitle: async () => null,
}));
vi.mock('../../../src/host/services/infra/sessionTitleCloudPush', () => ({
  pushSessionTitleToCloud: () => undefined,
}));
vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ updateSessionTitle: () => undefined }),
}));
vi.mock('../../../src/cli/bootstrap', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { CLISessionManager } = await import('../../../src/cli/session');

const PROMPT = '帮我看看 workspace 里的服务合同.pdf，先查一下有没有可用的 PDF 工具，再总结要点';
const SESSION_ID = 'web-session-title-live';

interface Stored extends Session {
  id: string;
}

function provisionalTitle(prompt: string): string {
  return prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt;
}

function createDb(title: string) {
  const sessions = new Map<string, Stored>();
  sessions.set(SESSION_ID, {
    id: SESSION_ID,
    title,
    modelConfig: { provider: 'xiaomi', model: 'test-model' },
    createdAt: 1,
    updatedAt: 1,
  });
  const messages: Message[] = [];
  return {
    isInitialized: true,
    initialize: vi.fn(async () => undefined),
    sessions,
    messages,
    getSession: (sessionId: string) => sessions.get(sessionId) ?? null,
    getMessagesForLoad: () => messages.map((message) => ({ ...message })),
    getTodos: () => [],
    addMessage: (_sessionId: string, message: Message) => {
      messages.push({ ...message });
    },
    updateSession: (sessionId: string, updates: Partial<Session>) => {
      const current = sessions.get(sessionId);
      if (!current) throw new Error(`Session not found: ${sessionId}`);
      sessions.set(sessionId, { ...current, ...updates, updatedAt: Date.now() });
    },
  };
}

function userMessage(): Message {
  return { id: 'user-1', role: 'user', content: PROMPT, timestamp: 10 };
}

function titlePayloads(pushes: Array<{ channel: string; data: unknown }>, sessionId = SESSION_ID): string[] {
  return pushes.flatMap(({ channel, data }) => {
    if (channel !== 'session:updated' || !data || typeof data !== 'object') return [];
    const event = data as { sessionId?: string; updates?: { title?: unknown } };
    if (event.sessionId !== sessionId) return [];
    return typeof event.updates?.title === 'string' ? [event.updates.title] : [];
  });
}

describe('CLISessionManager 标题落库后推送侧栏', () => {
  const pushes: Array<{ channel: string; data: unknown }> = [];
  let stop: (() => void) | undefined;

  beforeEach(() => {
    pushes.length = 0;
    quick.task.mockReset();
    quick.task.mockResolvedValue({ success: false, error: 'empty' });
    stop = onRendererPush((channel, data) => {
      pushes.push({ channel, data });
    });
  });

  afterEach(() => {
    stop?.();
  });

  async function managerWith(title: string) {
    const db = createDb(title);
    const manager = new CLISessionManager();
    Object.assign(manager as unknown as Record<string, unknown>, { _dbChecked: true, _db: db });
    return { db, manager };
  }

  it('小模型没给出标题时，规则摘要写入后总线收到 session:updated', async () => {
    const { db, manager } = await managerWith(provisionalTitle(PROMPT));
    await manager.addMessageToSession(SESSION_ID, userMessage());
    const expected = deriveRuleSummaryTitle(PROMPT, 'zh');

    await vi.waitFor(() => expect(titlePayloads(pushes)).toContain(expected));
    expect(db.sessions.get(SESSION_ID)?.title).toBe(expected);
    expect(titlePayloads(pushes).filter((title) => title === provisionalTitle(PROMPT))).toEqual([]);
  });

  it('小模型给出标题时，总线收到的就是该标题', async () => {
    quick.task.mockResolvedValue({ success: true, content: '服务合同要点' });
    const { db, manager } = await managerWith(provisionalTitle(PROMPT));
    await manager.addMessageToSession(SESSION_ID, userMessage());

    await vi.waitFor(() => expect(titlePayloads(pushes)).toEqual(['服务合同要点']));
    expect(db.sessions.get(SESSION_ID)?.title).toBe('服务合同要点');
  });

  it('等标题期间用户改过名：不覆盖，也不再广播过期标题', async () => {
    let release: (value: { success: boolean; error: string }) => void = () => undefined;
    quick.task.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { db, manager } = await managerWith(provisionalTitle(PROMPT));
    await manager.addMessageToSession(SESSION_ID, userMessage());
    await vi.waitFor(() => expect(quick.task).toHaveBeenCalled());

    await manager.updateSession(SESSION_ID, { title: '我的合同笔记' });
    release({ success: false, error: 'empty' });
    await vi.waitFor(() => expect(titlePayloads(pushes)).toEqual(['我的合同笔记']));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const stale = deriveRuleSummaryTitle(PROMPT, 'zh');
    expect(db.sessions.get(SESSION_ID)?.title).toBe('我的合同笔记');
    expect(titlePayloads(pushes)).toEqual(['我的合同笔记']);
    expect(titlePayloads(pushes)).not.toContain(stale);
  });

  it('空标题、非标题更新、写库失败都不广播', async () => {
    const { db, manager } = await managerWith('已有标题');
    await manager.updateSession(SESSION_ID, { title: '   ' });
    await manager.updateSession(SESSION_ID, { status: 'running' });
    db.updateSession = () => {
      throw new Error('disk full');
    };
    await manager.updateSession(SESSION_ID, { title: '写不进去' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(titlePayloads(pushes)).toEqual([]);
    expect(db.sessions.get(SESSION_ID)?.title).not.toBe('写不进去');
  });
});
