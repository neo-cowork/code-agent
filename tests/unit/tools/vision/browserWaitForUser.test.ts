// wait_for_user (N-BROWSER-WAIT-FOR-USER-RESUME-W2)
// 走 browserActionTool.execute + 真 SurfaceExecutionRuntime / ManagedBrowserProviderAdapter +
// 生产 createToolExecutionWatchdog；只有浏览器本体是假的。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import type { BrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';
import { ManagedBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import { SurfaceExecutionRuntime } from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { createToolExecutionWatchdog } from '../../../../src/host/agent/runtime/toolExecutionTimeout';
import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';
import { BROWSER_WAIT_FOR_USER } from '../../../../src/shared/constants/timeouts';
import { WAIT_FOR_USER_EVENT_ACTION, WAIT_FOR_USER_TIMEOUT_EVENT_ACTION } from '../../../../src/shared/contract/surfaceExecution';
import type { AgentEvent } from '../../../../src/shared/contract';
import type { ToolContext } from '../../../../src/host/tools/types';

const holder = vi.hoisted(() => ({ adapter: null as unknown, runtime: null as unknown }));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => undefined }),
}));
vi.mock('../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter')>()),
  getManagedBrowserProviderAdapter: () => holder.adapter,
}));
vi.mock('../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime')>()),
  getSurfaceExecutionRuntime: () => holder.runtime,
}));

function createFakeBrowser() {
  let running = false;
  let snapshot = 0;
  const close = vi.fn(async () => { running = false; });
  const tab = { id: 'tab-1', url: 'https://portal.example.test/gate', title: 'Gate' };
  const service = {
    logger: { log: vi.fn(), getLogsAsString: vi.fn(() => '') },
    beginTrace: vi.fn((args: { toolName: string; action: string; params?: Record<string, unknown> }) => ({
      id: 'trace-1', targetKind: 'browser', toolName: args.toolName, action: args.action, mode: 'headless',
      startedAtMs: 1, before: null, params: args.params || {},
    })),
    finishTrace: vi.fn((trace: Record<string, unknown>, args: { success: boolean; error?: string | null }) => ({
      ...trace, completedAtMs: 2, success: args.success, error: args.error || null, after: null,
      consoleErrors: [], networkFailures: [],
    })),
    ensureSession: vi.fn(async () => { running = true; return {}; }),
    isRunning: () => running,
    getActiveTab: () => (running ? { ...tab } : null),
    listTabs: () => (running ? [{ ...tab }] : []),
    getLiveTabUrl: () => tab.url,
    getPageContent: vi.fn(async () => ({ url: tab.url, title: tab.title, text: 'Welcome back, portal home.', links: [] })),
    getSessionState: () => ({
      sessionId: 'wait-session', profileId: 'isolated-profile', provider: 'system-chrome-cdp', running,
      tabCount: running ? 1 : 0,
      lease: running
        ? { leaseId: 'l', owner: 'managed-browser', acquiredAtMs: 1, lastHeartbeatAtMs: 1, expiresAtMs: Number.MAX_SAFE_INTEGER, ttlMs: 1800000, status: 'active' as const }
        : null,
      activeTab: running ? { ...tab, canGoBack: false, canGoForward: false } : null,
    }),
    onSessionChanged: () => () => undefined,
    getDomSnapshot: vi.fn(async () => {
      snapshot += 1;
      return { snapshotId: `snapshot-${snapshot}`, tabId: 'tab-1', capturedAtMs: Date.now(), url: tab.url, title: tab.title, headings: [], interactiveElements: [] };
    }),
    getElementBoundingBox: vi.fn(async () => ({ x: 1, y: 2, width: 3, height: 4 })),
    exportStorageState: vi.fn(async () => ({ path: '/x', accountState: {} })),
    close,
    setLeaseInUse: vi.fn(),
  };
  return { service: service as unknown as BrowserService, close };
}

const IDS = { conversationId: 'conversation-w', runId: 'run-w', agentId: 'agent-w' };

function setup() {
  const registry = new RunRegistry();
  registry.start({ runId: IDS.runId, sessionId: IDS.conversationId, workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const fake = createFakeBrowser();
  const resumeStore: BrowserResumeStateStore = {
    exportForConversation: vi.fn(async () => '/x'),
    importForConversation: vi.fn(async () => false),
    clearConversation: vi.fn(async () => undefined),
    activateConversation: vi.fn(),
  };
  const adapter = new ManagedBrowserProviderAdapter(runtime, () => fake.service, vi.fn(async () => undefined), resumeStore, { warn: vi.fn(), error: vi.fn() });
  holder.adapter = adapter;
  holder.runtime = runtime;
  return { runtime, adapter, fake };
}

let callSeq = 0;
function ctx(toolCallId = `tc-${++callSeq}`): ToolContext {
  return {
    sessionId: IDS.conversationId,
    runId: IDS.runId,
    agentId: IDS.agentId,
    currentToolCallId: toolCallId,
    workingDirectory: process.cwd(),
    requestPermission: vi.fn(async () => true),
  } as unknown as ToolContext;
}

type Harness = ReturnType<typeof setup>;
async function openPage(h: Harness): Promise<{ sessionId: string; subject: { sessionId: string; runId: string; agentId: string } }> {
  const result = await browserActionTool.execute({ action: 'get_dom_snapshot' }, ctx());
  expect(result.success).toBe(true);
  const binding = h.adapter.getBinding(IDS)!;
  return { sessionId: binding.surfaceSessionId, subject: { sessionId: binding.surfaceSessionId, runId: IDS.runId, agentId: IDS.agentId } };
}

function startWatchedWait(toolCallId: string, reason = '请完成页面上的验证') {
  const events: AgentEvent[] = [];
  const watchdog = createToolExecutionWatchdog({
    toolCallId, toolName: 'Browser', startedAt: Date.now(),
    onEvent: (event) => events.push(event), onTimeoutWarn: vi.fn(),
  });
  watchdog.startProgressReporter();
  const aborted = vi.fn();
  const result = watchdog.awaitExecution(
    browserActionTool.execute({ action: 'wait_for_user', reason }, ctx(toolCallId)),
    aborted,
  );
  return { events, watchdog, result, aborted };
}

describe('browser_action wait_for_user', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); delete process.env[BROWSER_WAIT_FOR_USER.LIMIT_ENV]; });

  it('① hands the page to the user with the reason, blocks until Done, then tells the model to re-read', async () => {
    const h = setup();
    const { subject, sessionId } = await openPage(h);
    const wait = startWatchedWait('tc-①', '请完成页面上的人机验证');
    await vi.advanceTimersByTimeAsync(500);
    const session = h.runtime.sessions.requireOwned(sessionId, subject);
    expect(session.state).toBe('waiting_human');
    const events = h.runtime.events.list(sessionId);
    const request = events.find((e) => e.operation?.action === WAIT_FOR_USER_EVENT_ACTION);
    expect(request).toMatchObject({ phase: 'human', status: 'waiting', userSummary: '请完成页面上的人机验证' });
    expect(events.at(-1)?.userSummary).toBe('请完成页面上的人机验证');

    await h.runtime.control(subject, 'resume');
    const result = await wait.result;
    wait.watchdog.stop();
    expect(result.success).toBe(true);
    expect(result.output).toContain('get_dom_snapshot');
    expect(h.runtime.sessions.requireOwned(sessionId, subject).state).toBe('running');
    // old element refs are rejected after takeover; the human-touched flag was consumed by this result
    const next = await browserActionTool.execute({ action: 'list_tabs' }, ctx());
    expect(next.output).not.toContain('A human used this page');
    expect(h.fake.close).not.toHaveBeenCalled();
  });

  it('②a Done before 120s: no tool_timeout event, budget does not fire', async () => {
    const h = setup();
    const { subject } = await openPage(h);
    const wait = startWatchedWait('tc-2a');
    await vi.advanceTimersByTimeAsync(100_000);
    await h.runtime.control(subject, 'resume');
    const result = await wait.result;
    wait.watchdog.stop();
    expect(result.success).toBe(true);
    expect(wait.events.filter((e) => e.type === 'tool_timeout')).toEqual([]);
    expect(wait.aborted).not.toHaveBeenCalled();
  });

  it('②b Done after 130s: the human wait is not counted, no tool_timeout event', async () => {
    process.env[BROWSER_WAIT_FOR_USER.LIMIT_ENV] = '400000';
    const h = setup();
    const { subject } = await openPage(h);
    const wait = startWatchedWait('tc-2b');
    await vi.advanceTimersByTimeAsync(131_000);
    await h.runtime.control(subject, 'resume');
    const result = await wait.result;
    wait.watchdog.stop();
    expect(result.success).toBe(true);
    expect(result.output).toContain('The user says they finished');
    expect(wait.events.filter((e) => e.type === 'tool_timeout')).toEqual([]);
    expect(wait.aborted).not.toHaveBeenCalled();
  });

  it('③ user-initiated takeover: next browser result starts with the human-touched note, once', async () => {
    const h = setup();
    const { subject } = await openPage(h);
    await h.runtime.control(subject, 'takeover', { reason: 'user takeover' });
    await h.runtime.control(subject, 'resume');
    const first = await browserActionTool.execute({ action: 'list_tabs' }, ctx());
    expect(first.success).toBe(true);
    expect(first.output?.startsWith('A human used this page since your last look')).toBe(true);
    expect(first.output).toContain('get_dom_snapshot');
    const second = await browserActionTool.execute({ action: 'list_tabs' }, ctx());
    expect(second.output).not.toContain('A human used this page');
  });

  it('④ timeout: WAIT_FOR_USER_TIMEOUT, session not stopped, window alive, bar event flips to timed-out, Done still resumes', async () => {
    process.env[BROWSER_WAIT_FOR_USER.LIMIT_ENV] = '5000';
    const h = setup();
    const { subject, sessionId } = await openPage(h);
    const wait = startWatchedWait('tc-4', '请登录你的账号');
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await wait.result;
    wait.watchdog.stop();
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('WAIT_FOR_USER_TIMEOUT');
    expect(result.error).toContain('End this turn with one plain sentence');
    expect(h.runtime.sessions.requireOwned(sessionId, subject).state).toBe('waiting_human');
    expect(h.fake.close).not.toHaveBeenCalled();
    const last = h.runtime.events.list(sessionId).at(-1);
    expect(last?.operation?.action).toBe(WAIT_FOR_USER_TIMEOUT_EVENT_ACTION);
    expect(last?.userSummary).toBe('请登录你的账号');
    await h.runtime.control(subject, 'resume');
    expect(h.runtime.sessions.requireOwned(sessionId, subject).state).toBe('running');
  });

  it('rejects an empty, long, or technical reason without taking over', async () => {
    const h = setup();
    const { subject, sessionId } = await openPage(h);
    for (const reason of ['', 'x'.repeat(121), 'open https://a.example/login', 'call get_dom_snapshot now', 'edit /Users/me/file.txt']) {
      const result = await browserActionTool.execute({ action: 'wait_for_user', reason }, ctx());
      expect(result.success).toBe(false);
      expect(result.metadata?.code).toBe('WAIT_FOR_USER_REASON_INVALID');
    }
    expect(h.runtime.sessions.requireOwned(sessionId, subject).state).toBe('running');
  });

  it('refuses when no browser session is open for the run', async () => {
    setup();
    const result = await browserActionTool.execute({ action: 'wait_for_user', reason: '请完成验证' }, ctx());
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('WAIT_FOR_USER_UNAVAILABLE');
  });
});
