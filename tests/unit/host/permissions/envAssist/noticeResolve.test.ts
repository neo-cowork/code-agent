// Evidence class: hermetic-protocol (fake native bridge + in-memory message store). Not real-device proof.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message } from '../../../../../src/shared/contract';
import type { EnvAssistNotice } from '../../../../../src/shared/contract/envAssist';
import type { PassiveBridge, PromptingBridge } from '../../../../../src/host/permissions/envAssist/probes/types';

const mocks = vi.hoisted(() => ({ messages: [] as Message[], events: [] as Array<{ sessionId: string; event: AgentEvent }> }));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async () => mocks.messages.map((m) => structuredClone(m)),
    addMessageToSession: async (_s: string, m: Message) => {
      const i = mocks.messages.findIndex((x) => x.id === m.id);
      if (i >= 0) mocks.messages[i] = m; else mocks.messages.push(m);
    },
  }),
}));
vi.mock('../../../../../src/host/services/agentEngine/agentEngineEventSink', () => ({
  emitExternalAgentEvent: (sessionId: string, event: AgentEvent) => { mocks.events.push({ sessionId, event }); },
}));
vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', () => ({ canRequestEnvGrant: () => true, resolveShellBridgeClientFromEnv: () => null }));
vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => true, openEnvSettings: vi.fn(async () => true) }));

import { publishEnvAssistToolNotice } from '../../../../../src/host/permissions/envAssist/toolNotice';
import { registerEnvAssistHandlers } from '../../../../../src/host/ipc/envAssist.ipc';
import { ipcHost, type HandlerFn } from '../../../../../src/host/platform';

/** -1744 undecided; a prompt that the user allows flips it to 0 granted. -1743 = refused. */
const tcc = { code: -1744 as 0 | -1743 | -1744, allowOnPrompt: true, prompts: 0 };
const passive: PassiveBridge = {
  AXIsProcessTrusted: async () => false, CGPreflightScreenCaptureAccess: async () => false, IOHIDCheckAccess: async () => 1,
  AEDeterminePermissionToAutomateTarget: async () => tcc.code,
};
const grant: PromptingBridge = {
  requestAccessibility: async () => undefined, CGRequestScreenCaptureAccess: async () => undefined, IOHIDRequestAccess: async () => undefined,
  AEDeterminePermissionToAutomateTarget: async () => { tcc.prompts++; if (tcc.allowOnPrompt) tcc.code = 0; },
};

let handler: HandlerFn;
const call = async (action: string, payload: unknown) => ((await handler({} as never, { action, payload })) as { data: unknown }).data;
const stored = () => mocks.messages.find((m) => m.id.startsWith('env-assist:'))!.metadata!.envAssist!;

async function showCalendarCard(): Promise<EnvAssistNotice> {
  const result = { success: false, error: 'denied', metadata: { code: 'not_authorized' } } as never;
  await publishEnvAssistToolNotice({ toolName: 'calendar', result, sessionId: 's', runId: 'run-1', onEvent: () => undefined });
  return stored();
}

beforeEach(() => {
  mocks.messages.length = 0; mocks.events.length = 0;
  Object.assign(tcc, { code: -1744, allowOnPrompt: true, prompts: 0 });
  vi.spyOn(ipcHost, 'handle').mockImplementation((_c, fn) => { handler = fn; });
  registerEnvAssistHandlers({
    available: () => true, open: vi.fn(async () => true), passiveBridge: passive, grantBridge: grant,
    findNotice: async (id) => mocks.messages.find((m) => m.id === `env-assist:${id}`)?.metadata?.envAssist,
  });
});

describe('env-assist card closes once the permission is granted', () => {
  it('①clicking allow → granted: persisted notice is resolved with no button, and broadcast', async () => {
    const card = await showCalendarCard();
    expect(card).toMatchObject({ phase: 'needs_user', action: { kind: 'request_grant' } });
    expect(await call('act', { noticeId: card.id, actionKind: 'request_grant', payload: { pane: 'automation' } }))
      .toMatchObject({ status: 'checked', outcome: { status: 'granted' } });
    // What a reload reads back.
    expect(stored()).toMatchObject({ id: card.id, phase: 'resolved', doneKey: 'env.done.calendar' });
    expect(stored().action).toBeUndefined();
    expect(mocks.events).toEqual([{ sessionId: 's', event: { type: 'env_assist_notice', data: stored() } }]);
    // A resolved card can't be clicked again.
    expect(await call('act', { noticeId: card.id, actionKind: 'request_grant', payload: { pane: 'automation' } })).toMatchObject({ status: 'rejected' });
  });

  it('①a click the user declines keeps the card open', async () => {
    tcc.allowOnPrompt = false;
    const card = await showCalendarCard();
    expect(await call('act', { noticeId: card.id, actionKind: 'request_grant', payload: { pane: 'automation' } }))
      .toMatchObject({ outcome: { status: 'undecided' } });
    expect(stored()).toMatchObject({ phase: 'needs_user', action: { kind: 'request_grant' } });
    expect(mocks.events).toHaveLength(0);
  });

  it('②granted in System Settings (no click): recheck closes the card without prompting', async () => {
    const card = await showCalendarCard();
    tcc.code = -1743;
    expect(await call('recheck', { noticeId: card.id })).toMatchObject({ status: 'checked', outcome: { status: 'denied' } });
    expect(stored().phase).toBe('needs_user');
    tcc.code = 0; // user flipped the switch in Settings
    expect(await call('recheck', { noticeId: card.id })).toMatchObject({ status: 'checked', outcome: { status: 'granted' } });
    expect(stored()).toMatchObject({ phase: 'resolved', doneKey: 'env.done.calendar' });
    expect(stored().action).toBeUndefined();
    expect(mocks.events).toHaveLength(1);
    expect(tcc.prompts).toBe(0);
    expect(await call('recheck', { noticeId: card.id })).toMatchObject({ status: 'rejected' });
    expect(await call('recheck', { noticeId: 'missing' })).toMatchObject({ status: 'rejected' });
  });

  it('concurrent rechecks (mount + window focus) resolve and broadcast once', async () => {
    const card = await showCalendarCard();
    tcc.code = 0;
    await Promise.all([call('recheck', { noticeId: card.id }), call('recheck', { noticeId: card.id })]);
    expect(stored().phase).toBe('resolved');
    expect(mocks.events).toHaveLength(1);
  });

  it('③model guidance (non-parking runs only) points at the card, asks to resend, and never promises a follow-up', async () => {
    const result = { success: false, error: 'denied', metadata: { code: 'not_authorized' } } as { error?: string };
    await publishEnvAssistToolNotice({ toolName: 'calendar', result: result as never, sessionId: 's', runId: 'run-2', onEvent: () => undefined });
    expect(result.error).toContain('allow it with that button on the card and then send the request again');
    expect(result.error).toContain('Do not claim you will check or continue on your own');
  });
});
