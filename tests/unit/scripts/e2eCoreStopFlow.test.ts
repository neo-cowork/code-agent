// @vitest-environment jsdom
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptEnv } from '../../../scripts/e2e-core/types';

const { approveCardMock, sendMessageMock } = vi.hoisted(() => ({
  approveCardMock: vi.fn(async () => {
    document.querySelector('[data-testid="permission-card"]')?.remove();
    return '允许一次';
  }),
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

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const visible = (el: Element) => !el.closest('[hidden]');

/** Playwright 定位器里 F09 用到的那几个方法，作用在 jsdom 的真实节点上（hasText 口径：压空白后子串匹配）。 */
function locator(selector: string, hasText?: string) {
  const els = () => [...document.querySelectorAll(selector)]
    .filter((el) => hasText === undefined || norm(el.textContent).includes(norm(hasText)));
  const handle = (el: Element) => ({
    isVisible: async () => visible(el),
    innerText: async () => el.textContent ?? '',
    evaluate: async <T>(fn: (e: Element) => T) => fn(el),
  });
  const loc = {
    all: async () => els().map(handle),
    first: () => loc,
    filter: (opts: { hasText: string }) => locator(selector, opts.hasText),
    isVisible: async () => els().some(visible),
    innerText: async () => els()[0]?.textContent ?? '',
    click: async () => undefined,
    waitFor: async () => {
      if (!els().some(visible)) throw new Error(`locator 超时：${selector}${hasText ? ` hasText=${hasText}` : ''}`);
    },
  };
  return loc;
}

const fakePage = {
  locator: (selector: string) => locator(selector),
  getByTestId: (id: string) => locator(`[data-testid="${id}"]`),
} as unknown as AttemptEnv['page'];

const PROMPT_HTML = '<div data-testid="user-message-content">用 curl 依次抓取 https://example.com、https://www.iana.org/help/example-domains 四个页面</div>';
const COMPOSER_HTML = '<textarea data-testid="chat-composer-textarea"></textarea>';
const STOP_HTML = '<button data-testid="composer-stop-button"></button>';
/** TraceNodeRenderer：活动轮正文还空时只渲染「正在组织回答…」占位，没有正文容器。 */
const PLACEHOLDER_NODE = '<div data-trace-node-type="assistant_text"><div class="py-1" aria-label="正在组织回答…"><span>正在组织回答…</span></div></div>';
/** TraceNodeRenderer：有正文时正文在 .select-text 里；生成中末尾挂 sr-only「正在生成」。 */
const bodyNode = (paragraphs: string[], streaming: boolean, hidden = false) =>
  `<div data-trace-node-type="assistant_text"${hidden ? ' hidden' : ''}><div aria-label="助手消息">`
  + `<div class="select-text"><div class="prose">${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}</div>`
  + `${streaming ? '<span class="sr-only">正在生成</span>' : ''}</div></div></div>`;
const turn = (...nodes: string[]) => `<div data-trace-turn-id="t1">${PROMPT_HTML}${nodes.join('')}</div>`;

let tmpDir = '';

function createEnv(scratch: Record<string, unknown> = {}): AttemptEnv {
  const sseFile = path.join(tmpDir, 'F09.sse');
  fs.writeFileSync(sseFile, `data: ${JSON.stringify({ type: 'turn_end', sessionId: 'session-f09' })}\n`);
  return {
    page: fakePage,
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
  afterEach(() => {
    document.body.innerHTML = '';
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('step 1 does not treat the user prompt (curl + URLs) as assistant output', async () => {
    document.body.innerHTML = STOP_HTML + turn();
    const env = createEnv();
    env.sessionIds = [];
    await expect(f09.steps[0].run(env)).rejects.toThrow(/助手有可见正文/);
    expect(env.scratch.visibleOutput).toBeUndefined();
  });

  it('step 1 does not treat the 正在组织回答… placeholder as assistant output', async () => {
    document.body.innerHTML = STOP_HTML + turn(PLACEHOLDER_NODE);
    const env = createEnv();
    env.sessionIds = [];
    await expect(f09.steps[0].run(env)).rejects.toThrow(/助手有可见正文/);
    expect(env.scratch.visibleOutput).toBeUndefined();
  });

  it('step 1 approves a pending card and records the visible body text without the sr-only 正在生成 marker', async () => {
    document.body.innerHTML = STOP_HTML + '<div data-testid="permission-card"></div>'
      + turn(bodyNode(['隐藏的旧正文'], false, true), PLACEHOLDER_NODE, bodyNode(['我先抓第一个页面，', '再逐页总结。'], true));
    const env = createEnv();
    env.sessionIds = [];
    await f09.steps[0].run(env);
    expect(approveCardMock).toHaveBeenCalledTimes(1);
    expect(env.scratch.visibleOutput).toBe('我先抓第一个页面， 再逐页总结。');
  });

  it('step 1 → stop → step 3 passes when the streamed body is still shown after the generating marker is gone', async () => {
    const env = createEnv();
    env.sessionIds = [];
    document.body.innerHTML = STOP_HTML + turn(bodyNode(['我先抓第一个页面，', '再逐页总结。'], true));
    await f09.steps[0].run(env);
    // 停止后：停止键与 sr-only 生成中标记撤掉，正文保留；输入框回来
    document.body.innerHTML = COMPOSER_HTML + turn(bodyNode(['我先抓第一个页面，', '再逐页总结。'], false));
    await expect(f09.steps[2].run(env)).resolves.toBeUndefined();
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock).toHaveBeenLastCalledWith(fakePage, '刚才抓到的第一个页面标题是什么？一句话回答');
  });

  it('step 3 fails when the recorded assistant text is gone, even though the prompt URLs are still on the page', async () => {
    document.body.innerHTML = COMPOSER_HTML + turn('<div>你停止了这次执行</div>');
    const env = createEnv({ visibleOutput: '我先抓第一个页面， 再逐页总结。' });
    await expect(f09.steps[2].run(env)).rejects.toThrow(/locator 超时/);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('step 3 fails when the composer does not come back after stop', async () => {
    document.body.innerHTML = turn(bodyNode(['我先抓第一个页面，'], false));
    const env = createEnv({ visibleOutput: '我先抓第一个页面，' });
    await expect(f09.steps[2].run(env)).rejects.toThrow(/chat-composer-textarea/);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('step 3 fails when step 1 never recorded assistant text', async () => {
    document.body.innerHTML = COMPOSER_HTML + turn(bodyNode(['x'], false));
    await expect(f09.steps[2].run(createEnv())).rejects.toThrow('未记录停止前的助手正文');
  });
});
