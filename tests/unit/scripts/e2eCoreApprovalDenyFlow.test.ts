// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { f06 } from '../../../scripts/e2e-core/approvalFlows';
import type { AttemptEnv, DbSnapshot } from '../../../scripts/e2e-core/types';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const isVisible = (el: Element) => el.isConnected && !el.closest('[hidden]');

interface FakeLocator {
  _els: () => Element[];
  first: () => FakeLocator;
  count: () => Promise<number>;
  isVisible: () => Promise<boolean>;
  innerText: () => Promise<string>;
  click: () => Promise<void>;
  evaluateAll: <T>(fn: (els: Element[]) => T) => Promise<T>;
  filter: (opts: { has?: FakeLocator; hasText?: string }) => FakeLocator;
  locator: (selector: string) => FakeLocator;
  getByTestId: (id: string) => FakeLocator;
  getByRole: (role: string, opts?: { name?: string; exact?: boolean }) => FakeLocator;
  getByText: (text: string, opts?: { exact?: boolean }) => FakeLocator;
}

function queryWithin(roots: ParentNode[], selector: string): Element[] {
  const seen = new Set<Element>();
  for (const root of roots) {
    for (const el of root.querySelectorAll(selector)) seen.add(el);
  }
  return [...seen];
}

function roleSelector(role: string): string {
  if (role === 'button') return 'button, [role="button"]';
  if (role === 'tab') return '[role="tab"]';
  return `${role}, [role="${role}"]`;
}

function makeLocator(getEls: () => Element[]): FakeLocator {
  const loc: FakeLocator = {
    _els: getEls,
    first: () => makeLocator(() => {
      const els = getEls();
      return els.length ? [els[0]] : [];
    }),
    count: async () => getEls().length,
    isVisible: async () => getEls().some(isVisible),
    innerText: async () => getEls()[0]?.textContent ?? '',
    click: async () => {
      const target = getEls().find(isVisible) ?? getEls()[0];
      if (!target) throw new Error('FakeLocator click: element not found');
      (target as HTMLElement).click();
    },
    evaluateAll: async <T>(fn: (els: Element[]) => T) => fn(getEls()),
    filter: (opts) => makeLocator(() => getEls().filter((el) => {
      if (opts.has && !opts.has._els().some((child) => el.contains(child))) return false;
      if (opts.hasText !== undefined && !norm(el.textContent).includes(norm(opts.hasText))) return false;
      return true;
    })),
    locator: (selector) => makeLocator(() => queryWithin(getEls(), selector)),
    getByTestId: (id) => makeLocator(() => queryWithin(getEls(), `[data-testid="${id}"]`)),
    getByRole: (role, opts) => makeLocator(() =>
      queryWithin(getEls(), roleSelector(role)).filter((el) => {
        if (opts?.name === undefined) return true;
        return opts.exact
          ? norm(el.textContent) === norm(opts.name)
          : norm(el.textContent).includes(norm(opts.name));
      }),
    ),
    getByText: (text, opts) => makeLocator(() =>
      queryWithin(getEls(), '*').filter((el) => (
        opts?.exact ? norm(el.textContent) === norm(text) : norm(el.textContent).includes(norm(text))
      )),
    ),
  };
  return loc;
}

const fakePage = {
  locator: (selector: string) => makeLocator(() => queryWithin([document], selector)),
  getByTestId: (id: string) => makeLocator(() => queryWithin([document], `[data-testid="${id}"]`)),
  getByRole: (role: string, opts?: { name?: string; exact?: boolean }) =>
    makeLocator(() => queryWithin([document], roleSelector(role)).filter((el) => {
      if (opts?.name === undefined) return true;
      return opts.exact
        ? norm(el.textContent) === norm(opts.name)
        : norm(el.textContent).includes(norm(opts.name));
    })),
  getByText: (text: string, opts?: { exact?: boolean }) =>
    makeLocator(() => queryWithin([document], '*').filter((el) => (
      opts?.exact ? norm(el.textContent) === norm(text) : norm(el.textContent).includes(norm(text))
    ))),
} as unknown as AttemptEnv['page'];

function cardHtml(requestId: string, command: string): string {
  return `<div data-permission-request-id="${requestId}">`
    + '<div data-testid="permission-card">'
    + `<div data-testid="permission-args-preview">${command}</div>`
    + '<button type="button">暂不</button>'
    + '</div></div>';
}

function createEnv(snapshot?: Partial<DbSnapshot>): AttemptEnv {
  const data: DbSnapshot = {
    sessions: [{ id: 'session-f06', parent_session_id: null }],
    messages: [
      {
        session_id: 'session-f06',
        role: 'assistant',
        content: '抓取 example.org 的 curl 命令被拒绝，未执行，文件也没有生成。',
      },
    ],
    toolEvents: [],
    pendingApprovals: [],
    permissionDecisions: [
      {
        session_id: 'session-f06',
        tool_name: 'Bash',
        final_outcome: 'deny',
        history_outcome: 'ask-denied',
        reason: 'user',
        recorded_at: 1_000,
      },
    ],
    cronJobs: [],
    cronExecutions: [],
    ...snapshot,
  };
  return {
    page: fakePage,
    server: {} as AttemptEnv['server'],
    sessionIds: ['session-f06'],
    startedAtMs: 0,
    sseFile: 'F06-a2.sse',
    scratch: {},
    note: vi.fn(),
    readDb: vi.fn(async () => ({ file: 'db-10.json', data })),
  };
}

describe('e2e-core F06 approval deny flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('(i) resolves step 2 when no stop button ever shows and nothing changes after deny', async () => {
    document.body.innerHTML = cardHtml('perm-1', 'curl -sSL https://example.org -o example-org.html')
      + '<div>抓取仍在后台进行，完成后我会在这里给出结果。</div>';
    document.querySelector('[data-permission-request-id="perm-1"] button')?.addEventListener('click', () => {
      document.querySelector('[data-permission-request-id="perm-1"]')?.remove();
    });

    const env = createEnv();
    const runPromise = f06.steps[1].run(env);
    const outcome = runPromise.then(() => null, (err: unknown) => err);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeNull();
    expect(env.scratch.preview).toBe('curl -sSL https://example.org -o example-org.html');
  });

  it('(ii) rejects step 2 with the re-ask error when a new permission card shows after deny', async () => {
    document.body.innerHTML = cardHtml('perm-1', 'curl -sSL https://example.org -o example-org.html')
      + '<div>后台任务 1 后台 进行中 用 curl 抓取 example.org</div>';
    document.querySelector('[data-permission-request-id="perm-1"] button')?.addEventListener('click', () => {
      document.querySelector('[data-permission-request-id="perm-1"]')?.remove();
      setTimeout(() => {
        document.body.insertAdjacentHTML('beforeend', cardHtml('perm-2', 'curl https://example.org > example-org.html'));
      }, 2_000);
    });

    const env = createEnv();
    const runPromise = f06.steps[1].run(env);
    const outcome = runPromise.then(() => null, (err: unknown) => err);
    await vi.runAllTimersAsync();
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/拒绝后又弹出审批卡（重试了动作）/);
  });

  it('(iii) rejects step 3 when a later ask-* permissionDecision row exists for the denied tool', async () => {
    const env = createEnv({
      sessions: [
        { id: 'session-f06', parent_session_id: null },
        { id: 'session-f06-bg', parent_session_id: 'session-f06' },
      ],
      permissionDecisions: [
        {
          session_id: 'session-f06-bg',
          tool_name: 'Bash',
          final_outcome: 'deny',
          history_outcome: 'ask-denied',
          reason: 'user',
          recorded_at: 1_000,
        },
        {
          session_id: 'session-f06-bg',
          tool_name: 'Bash',
          final_outcome: 'allow',
          history_outcome: 'ask-approved',
          reason: 'user',
          recorded_at: 2_500,
        },
      ],
    });

    const runPromise = f06.steps[2].run(env);
    const outcome = runPromise.then(() => null, (err: unknown) => err);
    await vi.runAllTimersAsync();
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/拒绝后 Bash 又发起了需确认的审批/);
  });

  it('passes step 3 when only the initial deny row exists and the wrap-up reply states non-execution', async () => {
    const env = createEnv();
    const runPromise = f06.steps[2].run(env);
    const outcome = runPromise.then(() => null, (err: unknown) => err);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeNull();
  });
});
