import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

const dbState = {
  sessions: [] as Array<Record<string, any>>,
  messages: [] as Array<{ sessionId: string; message: Record<string, any> }>,
};

/** 注入到 db.addMessage 里的钩子，用来在"写消息"这一刻模拟并发切会话。 */
let onAddMessage: (() => void) | null = null;

const dbBase = {
  createSession: vi.fn((session: Record<string, any>) => {
    dbState.sessions.push({ messageCount: 0, ...session });
  }),
  getSession: vi.fn((id: string) => dbState.sessions.find((session) => session.id === id) ?? null),
  updateSession: vi.fn((id: string, updates: Record<string, unknown>) => {
    const session = dbState.sessions.find((item) => item.id === id);
    if (session) Object.assign(session, updates);
  }),
  addMessage: vi.fn((sessionId: string, message: Record<string, any>) => {
    dbState.messages.push({ sessionId, message });
    onAddMessage?.();
  }),
  updateMessage: vi.fn(),
  getProjectRepo: vi.fn(() => ({ assignSessionProject: vi.fn() })),
  logAuditEvent: vi.fn(),
  getRecentMessages: vi.fn(() => [] as unknown[]),
  getTodos: vi.fn(() => [] as unknown[]),
};

/** 只有上面这些方法是被断言的；其余 db 方法一律返回空，免得为了跑通链路把整个 DB 抄一遍。 */
const dbMock = new Proxy(dbBase as Record<string, any>, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    return () => [];
  },
}) as typeof dbBase;

let quickTaskResolve: ((value: { success: boolean; content: string }) => void) | null = null;
/** 默认即时返回；只有要测「小模型很慢」的窗口时才挂起。 */
let deferQuickTask = false;
const quickTask = vi.fn(() => (deferQuickTask
  ? new Promise((resolve) => {
    quickTaskResolve = resolve as (value: { success: boolean; content: string }) => void;
  })
  : Promise.resolve({ success: true, content: '打个招呼' })));

vi.mock('../../../../src/host/model/quickModel', () => ({
  isQuickModelAvailable: () => true,
  quickTask,
}));

let uiLanguage: 'zh' | 'en' = 'zh';
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: uiLanguage } }) }),
}));

vi.mock('../../../../src/host/platform', () => ({
  AppWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }],
  },
}));

vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => dbMock,
}));

vi.mock('../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({ ensureProjectForWorkspace: vi.fn(async () => ({ id: 'proj_test' })) }),
}));

vi.mock('../../../../src/host/services/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    initSessionMode: vi.fn(),
    markUnattendedSession: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn() }),
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => false,
  getSupabase: () => null,
}));

async function makeManager() {
  const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
  return new SessionManager();
}

function userMessage(content: string) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    role: 'user' as const,
    content,
    timestamp: 1_700_000_000_000,
  };
}

/** 让 fire-and-forget 的标题链路推进一拍。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 等 fire-and-forget 的标题链路跑完（等不到就让断言去报，不静默跳过）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 50 && quickTask.mock.calls.length === 0; i += 1) {
    await tick();
  }
  expect(quickTask).toHaveBeenCalled();
  for (let i = 0; i < 10; i += 1) await tick();
}

/** 等标题链路挂在小模型上（deferQuickTask 模式）。 */
async function waitForQuickTaskCall(): Promise<void> {
  for (let i = 0; i < 50 && !quickTaskResolve; i += 1) {
    await tick();
  }
  expect(quickTask).toHaveBeenCalled();
}

describe('SessionManager 自动标题', () => {
  beforeEach(() => {
    dbState.sessions = [];
    dbState.messages = [];
    onAddMessage = null;
    quickTaskResolve = null;
    deferQuickTask = false;
    uiLanguage = 'zh';
    vi.clearAllMocks();
  });

  describe('标题语言跟随用户消息', () => {
    async function titlePromptFor(message: string, ui: 'zh' | 'en' = 'zh', reply = 'x title'): Promise<{ prompt: string; title: string | undefined }> {
      uiLanguage = ui;
      quickTask.mockClear();
      quickTask.mockImplementationOnce(() => Promise.resolve({ success: true, content: reply }) as never);
      const manager = await makeManager();
      const session = await manager.createSession({
        title: '新对话',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
      });
      await manager.addMessageToSession(session.id, userMessage(message) as never);
      await settle();
      return { prompt: String((quickTask.mock.calls[0] as unknown[])[0]), title: dbMock.getSession(session.id)?.title as string | undefined };
    }

    it('英文消息：提示词要求英文标题，且不再写死中文优先', async () => {
      const { prompt, title } = await titlePromptFor('Summarize the three attached meeting notes into a weekly report', 'zh', 'Weekly report from meeting notes');
      expect(prompt).toContain('Write the title in English');
      expect(prompt).toContain('3-8 English words');
      expect(prompt).not.toContain('中文优先');
      expect(prompt).toContain('Summarize the three attached meeting notes');
      expect(title).toBe('Weekly report from meeting notes');
    });

    it('中文消息：提示词要求中文标题（英文 UI 下也一样）', async () => {
      const { prompt } = await titlePromptFor('把三份会议纪要整理成一份周报', 'en', '会议纪要周报');
      expect(prompt).toContain('Write the title in Chinese');
      expect(prompt).toContain('10-25 Chinese characters');
    });

    it('中英混写：跟随消息的主语言', async () => {
      const zhMain = await titlePromptFor('帮我把这个 PR 的 review 意见整理成清单然后回复给同事', 'en');
      expect(zhMain.prompt).toContain('Write the title in Chinese');
      const enMain = await titlePromptFor('Please review the 登录 flow and list every bug you can find in the redirect handler', 'zh');
      expect(enMain.prompt).toContain('Write the title in English');
    });

    it('消息判不出语言（纯数字/符号）：回落到 UI 语言', async () => {
      const en = await titlePromptFor('12345 ??? 😀', 'en');
      expect(en.prompt).toContain('cannot be determined; write the title in English');
      const zh = await titlePromptFor('12345 ??? 😀', 'zh');
      expect(zh.prompt).toContain('cannot be determined; write the title in Chinese');
    });

    it('小模型失败：降级到消息前缀标题，行为不变', async () => {
      uiLanguage = 'en';
      quickTask.mockImplementationOnce(() => Promise.resolve({ success: false, content: '' }) as never);
      const manager = await makeManager();
      const session = await manager.createSession({
        title: '新对话',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
      });
      await manager.addMessageToSession(session.id, userMessage('Summarize the notes') as never);
      await settle();
      expect(dbMock.getSession(session.id)?.title).toBe('Summarize the notes');
    });
  });

  it('并发切会话时，标题只写给消息真正所属的会话', async () => {
    const manager = await makeManager();
    const target = await manager.createSession({
      title: '新对话',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
    });
    const other = await manager.createSession({
      title: '新对话',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
    });

    // 标题触发点只能有一个，且必须带显式 sessionId：多挂一次隐式 currentSessionId 的，
    // 就是把标题写到别的会话头上的那条路。
    const titleCalls: string[] = [];
    const proto = Object.getPrototypeOf(manager) as Record<string, (...args: unknown[]) => unknown>;
    const original = proto.maybeUpdateTitleForSession;
    proto.maybeUpdateTitleForSession = function patched(this: unknown, ...args: unknown[]) {
      titleCalls.push(args[0] as string);
      return original.apply(this, args);
    };

    (manager as unknown as { currentSessionId: string }).currentSessionId = target.id;
    // 写消息的瞬间用户新建/切走了会话——旧实现的隐式 currentSessionId 路径会在这里
    // 把这条消息的标题写到 other 头上。
    onAddMessage = () => {
      (manager as unknown as { currentSessionId: string }).currentSessionId = other.id;
    };

    await manager.addMessage(userMessage('你好') as never);
    await settle();
    proto.maybeUpdateTitleForSession = original;

    expect(titleCalls).toEqual([target.id]);

    expect(dbMock.getSession(target.id)?.title).toBe('打个招呼');
    expect(dbMock.getSession(other.id)?.title).toBe('新对话');
  });

  it('标题生成期间会话已被改名时不覆盖用户的标题', async () => {
    deferQuickTask = true;
    const manager = await makeManager();
    const session = await manager.createSession({
      title: '新对话',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
    });

    await manager.addMessageToSession(session.id, userMessage('你好') as never);
    await waitForQuickTaskCall();

    // 小模型还没返回，用户先手动改了名
    await manager.updateSession(session.id, { title: '我自己起的名字' });
    quickTaskResolve?.({ success: true, content: '打个招呼' });
    await tick();

    expect(dbMock.getSession(session.id)?.title).toBe('我自己起的名字');
  });
});
