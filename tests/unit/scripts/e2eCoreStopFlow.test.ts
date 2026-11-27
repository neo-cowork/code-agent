import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptEnv } from '../../../scripts/e2e-core/types';

interface FakeNode { text: string; visible: boolean }
interface FakeState { body: string; assistant: FakeNode[]; cardVisible: boolean }

const { approveCardMock, sendMessageMock } = vi.hoisted(() => ({
  approveCardMock: vi.fn(async (page: { __state: FakeState }) => { page.__state.cardVisible = false; return '允许一次'; }),
  sendMessageMock: vi.fn(async () => undefined),
}));

vi.mock('../../../scripts/e2e-core/ui', () => ({
  approveCard: approveCardMock,
  driveTurn: vi.fn(async () => undefined),
  openFolderSession: vi.fn(async () => 'session-f09'),
  sendMessage: sendMessageMock,
  sleep: vi.fn(async () => undefined),
  waitFor: async (what: string, check: () => Promise<boolean>) => {
    for (let i = 0; i < 5; i++) if (await check().catch(() => false)) return;
    throw new Error(`等待超时：${what}`);
  },
}));

import { f09 } from '../../../scripts/e2e-core/stopFlow';

const PROMPT_BODY = '用 curl 依次抓取 https://example.com、https://www.iana.org/help/example-domains 四个页面';

function fakePage(state: FakeState): AttemptEnv['page'] {
  const nodes = () => state.assistant.map((n) => ({
    isVisible: async () => n.visible,
    innerText: async () => n.text,
  }));
  return {
    __state: state,
    getByTestId: (id: string) => {
      const loc = {
        first: () => loc,
        waitFor: async () => undefined,
        isVisible: async () => (id === 'permission-card' ? state.cardVisible : true),
      };
      return loc;
    },
    locator: (selector: string) => {
      if (selector === 'body') return { innerText: async () => state.body };
      if (!selector.includes('assistant_text')) throw new Error(`unexpected selector ${selector}`);
      return {
        all: async () => nodes(),
        filter: ({ hasText }: { hasText: string }) => ({
          first: () => ({
            waitFor: async () => {
              if (!state.assistant.some((n) => n.visible && n.text.includes(hasText))) throw new Error('locator 超时：助手正文不可见');
            },
          }),
        }),
      };
    },
  } as unknown as AttemptEnv['page'];
}

let tmpDir = '';

function createEnv(state: FakeState, scratch: Record<string, unknown> = {}): AttemptEnv {
  const sseFile = path.join(tmpDir, 'F09.sse');
  fs.writeFileSync(sseFile, `data: ${JSON.stringify({ type: 'turn_end', sessionId: 'session-f09' })}\n`);
  return {
    page: fakePage(state),
    server: {} as AttemptEnv['server'],
    sessionIds: ['session-f09'],
    startedAtMs: 0,
    sseFile,
    scratch,
    note: vi.fn(),
    readDb: vi.fn(async () => ({
      file: 'db-1.json',
      data: {
        sessions: [{ id: 'session-f09' }],
        messages: [{ session_id: 'session-f09', role: 'assistant', content: '标题是 Example Domain。' }],
        toolEvents: [],
        pendingApprovals: [],
        permissionDecisions: [],
        cronJobs: [],
        cronExecutions: [],
      },
    })),
  };
}

describe('e2e-core F09 stopFlow', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-f09-'));
    approveCardMock.mockClear();
    sendMessageMock.mockClear();
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('step 1 does not treat the user prompt (curl + URLs in body) as assistant output', async () => {
    const env = createEnv({ body: PROMPT_BODY, assistant: [], cardVisible: false });
    env.sessionIds = [];
    await expect(f09.steps[0].run(env)).rejects.toThrow(/助手有可见正文/);
    expect(env.scratch.visibleOutput).toBeUndefined();
  });

  it('step 1 approves a pending card and records the first visible non-empty assistant text', async () => {
    const state: FakeState = {
      body: PROMPT_BODY,
      assistant: [{ text: '隐藏的旧正文', visible: false }, { text: '   ', visible: true }, { text: '我先抓第一个页面。', visible: true }],
      cardVisible: true,
    };
    const env = createEnv(state);
    env.sessionIds = [];
    await f09.steps[0].run(env);
    expect(approveCardMock).toHaveBeenCalledTimes(1);
    expect(env.scratch.visibleOutput).toBe('我先抓第一个页面。');
  });

  it('step 3 passes when the recorded assistant text is visible again after stop', async () => {
    const env = createEnv(
      { body: PROMPT_BODY, assistant: [{ text: '我先抓第一个页面。', visible: true }], cardVisible: false },
      { visibleOutput: '我先抓第一个页面。' },
    );
    await expect(f09.steps[2].run(env)).resolves.toBeUndefined();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('step 3 fails when the recorded assistant text is gone, even though the prompt URLs are still on the page', async () => {
    const env = createEnv(
      { body: `${PROMPT_BODY}\n你停止了这次执行`, assistant: [], cardVisible: false },
      { visibleOutput: '我先抓第一个页面。' },
    );
    await expect(f09.steps[2].run(env)).rejects.toThrow(/助手正文不可见/);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('step 3 fails when step 1 never recorded assistant text', async () => {
    const env = createEnv({ body: PROMPT_BODY, assistant: [{ text: 'x', visible: true }], cardVisible: false });
    await expect(f09.steps[2].run(env)).rejects.toThrow('未记录停止前的助手正文');
  });
});
