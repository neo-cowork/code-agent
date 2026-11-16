// Evidence class: hermetic-protocol (SQLite durable kernel + production engine/resolver/finalizer/IPC; fake TCC bridges).
// N-FIX-ENV-ASSIST-CARD-STAYS-AFTER-GRANT ⑤: a refused calendar read parks the run, the card is shown,
// and the grant (button click) resumes the same run/tool call without the user re-asking.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import type { Message } from '../../../../src/shared/contract';
import type { PassiveBridge, PromptingBridge } from '../../../../src/host/permissions/envAssist/probes/types';

const store = vi.hoisted(() => ({ messages: [] as Message[], bridge: null as PassiveBridge | null, db: {} as Record<string, unknown> }));
vi.mock('../../../../src/host/services/core/databaseService', () => ({ getDatabase: () => store.db }));
// Run history comes from the fixture's SQLite; the card message is kept beside it in memory.
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async (sessionId: string) => [
      ...((store.db.getMessages as ((id: string) => Message[]) | undefined)?.(sessionId) ?? []),
      ...store.messages.map((m) => structuredClone(m)),
    ],
    addMessageToSession: async (_s: string, m: Message) => {
      const i = store.messages.findIndex((x) => x.id === m.id);
      if (i >= 0) store.messages[i] = m; else store.messages.push(m);
    },
  }),
}));
vi.mock('../../../../src/host/services/agentEngine/agentEngineEventSink', () => ({ emitExternalAgentEvent: () => undefined }));
vi.mock('../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => true, openEnvSettings: vi.fn(async () => true) }));
vi.mock('../../../../src/host/permissions/envAssist/shellBridge/client', () => ({
  canRequestEnvGrant: () => true,
  resolveShellBridgeClientFromEnv: () => (store.bridge ? {} : null),
}));
vi.mock('../../../../src/host/permissions/envAssist/probes/shellPassiveBridge', () => ({ createShellPassiveBridge: () => store.bridge }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/services/infra/logger')>(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn }),
}));

import { harness, databasePorts } from './envResumeHarness';
import { registerEnvResumeContinuer } from '../../../../src/host/runtime/envResumeWaiter';
import { ENV_RESUME_POLL_INTERVAL_MS, ENV_RESUME_TIMEOUT_MS } from '../../../../src/shared/constants/envResume';
import { envResumeProbeFactory, registerEnvAssistHandlers } from '../../../../src/host/ipc/envAssist.ipc';
import { ipcHost, type HandlerFn } from '../../../../src/host/platform';
import { getDefaultWorkDirectory } from '../../../../src/host/config/configPaths';

/** Calendar is EventKit (perm_calendars): 0 undecided → the one dialog → 3 full access; 2 refused. Never Apple events. */
const tcc = { status: 0 as 0 | 2 | 3 };
const noAppleEvents = async (): Promise<never> => { throw new Error('calendar must not touch Apple events'); };
const passive: PassiveBridge = {
  AXIsProcessTrusted: async () => false, CGPreflightScreenCaptureAccess: async () => false, IOHIDCheckAccess: async () => 1,
  AEDeterminePermissionToAutomateTarget: noAppleEvents,
  EKAuthorizationStatusForEvents: async () => tcc.status,
};
const grant: PromptingBridge = {
  requestAccessibility: async () => undefined, CGRequestScreenCaptureAccess: async () => undefined, IOHIDRequestAccess: async () => undefined,
  AEDeterminePermissionToAutomateTarget: noAppleEvents,
  requestFullAccessToEvents: async () => { tcc.status = 3; },
};

let fixture: Awaited<ReturnType<typeof harness>> | undefined;
let workspace = '';
afterEach(() => {
  fixture?.close(); fixture = undefined; registerEnvResumeContinuer(null); vi.useRealTimers(); vi.restoreAllMocks();
  warn.mockClear(); store.messages.length = 0; store.bridge = null; tcc.status = 0;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/**
 * Wait for the continuation to either reach the live loop or stop. Only the waiter's own stop counts:
 * other warns (e.g. the connector reconnect warn on not_authorized, #3342) fire at park time and would end the wait early.
 */
async function settled(f: NonNullable<typeof fixture>) {
  const stopped = () => warn.mock.calls.some(([message, data]) => message === 'Environment auto-continue stopped'
    && (data as { reason?: string } | undefined)?.reason !== 'timeout');
  await vi.waitFor(() => expect(f.counts().resumes > 0 || stopped()).toBe(true), { timeout: 5000 });
}

async function parkedCalendar(plannedFolder?: string) {
  vi.useFakeTimers();
  workspace = plannedFolder ?? realpathSync(mkdtempSync(path.join(tmpdir(), 'env-resume-cal-')));
  fixture = await harness(workspace, ':memory:', false, true);
  store.db = databasePorts.current;
  return fixture;
}

describe('⑤ calendar refusal parks the run and the grant resumes it', () => {
  it('a refused calendar read parks (no failed result to the model) and shows the allow card', async () => {
    const f = await parkedCalendar();
    f.wire(async () => 'red');
    const { emitted } = await f.park();
    expect(await f.repository.get('env-run')).toMatchObject({
      status: 'waiting', interruptCause: 'env_blocked', envBlocked: { class: 'perm_calendars', target: 'calendar', toolCallId: 'env-call' },
    });
    expect(f.db.prepare("SELECT * FROM tool_execution_events WHERE phase='complete'").all()).toHaveLength(0);
    const card = emitted.find((e) => e.type === 'env_assist_notice')?.data as { id: string; phase: string; action: { kind: string } };
    expect(card).toMatchObject({ class: 'perm_calendars', phase: 'needs_user', parkedToolCallId: 'env-call', target: { id: 'calendar' }, action: { kind: 'request_grant', payload: { pane: 'calendars' } } });
    expect(store.messages.find((m) => m.id === `env-assist:${card.id}`)?.metadata?.envAssist).toMatchObject({ phase: 'needs_user', parkedToolCallId: 'env-call' });
  });

  it('real shape: the session folder (任务_…) was never created because the run only read — resume recreates it instead of native_workspace_unavailable', async () => {
    const planned = path.join(getDefaultWorkDirectory(), `任务_1115_日历续做-${process.pid}-${Date.now()}`);
    expect(existsSync(planned)).toBe(false);
    const f = await parkedCalendar(planned);
    let granted = false;
    f.wire(async () => granted ? 'green' : 'red');
    await f.park();
    expect(existsSync(planned)).toBe(false); // what the Dev package had at resume time
    f.green(); granted = true;
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS);
    // mkdir/realpath are real filesystem I/O: let the event loop run instead of only fake-timer ticks.
    await settled(f);
    expect(warn).not.toHaveBeenCalledWith('Environment auto-continue stopped', expect.anything());
    expect(existsSync(planned)).toBe(true);
    expect(f.counts()).toMatchObject({ executions: 2, resumes: 1, seenCalls: ['env-call', 'env-call'] });
  });

  it('clicking allow after the waiter timed out still resumes the same run/call once, and closes the card', async () => {
    const f = await parkedCalendar();
    let granted = false;
    f.wire(async () => granted ? 'green' : 'red');
    const { emitted } = await f.park();
    const card = emitted.find((e) => e.type === 'env_assist_notice')!.data as { id: string };
    await vi.advanceTimersByTimeAsync(ENV_RESUME_TIMEOUT_MS + 1); // nobody clicked within the polling window
    expect(f.counts().resumes).toBe(0);

    let handler: HandlerFn | undefined;
    vi.spyOn(ipcHost, 'handle').mockImplementation((_c, fn) => { handler = fn; });
    registerEnvAssistHandlers({
      available: () => true, open: vi.fn(async () => true), passiveBridge: passive, grantBridge: grant,
      calendarGranted: async () => undefined, sleep: async () => undefined,
      findNotice: async (id) => store.messages.find((m) => m.id === `env-assist:${id}`)?.metadata?.envAssist,
    });
    const res = await handler!({} as never, { action: 'act', payload: { noticeId: card.id, actionKind: 'request_grant', payload: { pane: 'calendars' } } });
    expect(res).toMatchObject({ data: { status: 'checked', outcome: { status: 'granted' } } });
    f.green(); granted = true;
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS);
    await settled(f);
    expect(f.counts()).toEqual({ executions: 2, resumes: 1, seenCalls: ['env-call', 'env-call'], seenRuns: ['env-run', 'env-run'] });
    expect(f.messages().filter((m) => m.role === 'user')).toHaveLength(1);
    expect(store.messages.find((m) => m.id === `env-assist:${card.id}`)?.metadata?.envAssist).toMatchObject({ phase: 'resolved' });
  });

  it('the production resume probe reads the EventKit truth passively (also for runs parked as perm_automation before the switch)', async () => {
    store.bridge = passive;
    for (const klass of ['perm_calendars', 'perm_automation'] as const) {
      const block = { class: klass, target: 'calendar', toolCallId: 'c' };
      tcc.status = 2;
      expect(await envResumeProbeFactory(block)()).toBe('red');
      tcc.status = 0;
      expect(await envResumeProbeFactory(block)()).toBe('red');
      tcc.status = 3;
      expect(await envResumeProbeFactory(block)()).toBe('green');
    }
    store.bridge = null;
    expect(await envResumeProbeFactory({ class: 'perm_calendars', target: 'calendar', toolCallId: 'c' })()).toBe('unavailable');
    expect(await envResumeProbeFactory({ class: 'perm_automation', target: 'photos', toolCallId: 'c' })()).toBe('unavailable');
    expect(warn).toHaveBeenCalledWith('Env resume probe unavailable', expect.objectContaining({ reason: 'unsupported_target' }));
  });

  it('the production continue route is registered with the real resume probe (static wiring)', () => {
    const agentRoutes = readFileSync(path.join(__dirname, '../../../../src/web/routes/agent.ts'), 'utf8');
    expect(agentRoutes).toContain('registerAgentContinueRoute(router, runRegistry, undefined, undefined, envResumeProbeFactory);');
  });
});
