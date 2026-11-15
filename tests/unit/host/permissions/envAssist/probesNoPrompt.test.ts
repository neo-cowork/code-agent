import { describe, expect, it, vi } from 'vitest';
import { accessibilityProbe, automationProbe, inputMonitoringProbe, screenRecordingProbe } from '../../../../../src/host/permissions/envAssist/probes/passiveProbes';
import type { PassiveBridge, PromptingBridge } from '../../../../../src/host/permissions/envAssist/probes/types';
import * as grants from '../../../../../src/host/permissions/envAssist/grants/requestGrant';
import { registerEnvAssistHandlers } from '../../../../../src/host/ipc/envAssist.ipc';
import type { EnvAssistNotice } from '../../../../../src/shared/contract/envAssist';
import { EnvAssistSchemas } from '../../../../../src/shared/ipc/schemas/envAssist';
import { ipcHost, type HandlerFn } from '../../../../../src/host/platform';

const logs = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => ({ ...await importOriginal<object>(), createLogger: () => logs }));

// Native Apple-event OSStatus and IOHIDAccessType fixtures: no invented success objects.
const fixtures = [
  { code: 0, iohid: 0, status: 'granted' },
  { code: -1743, iohid: 1, status: 'denied' },
  { code: -1744, iohid: 2, status: 'undecided' },
  { code: -600, iohid: 1, status: 'not_running' },
] as const;

const iohidFixtures = [
  { iohid: 0, status: 'granted' },
  { iohid: 1, status: 'denied' },
  { iohid: 2, status: 'undecided' },
] as const;

class NativeFake implements PassiveBridge {
  promptingCalls = 0;
  constructor(
    readonly code: typeof fixtures[number]['code'],
    readonly iohid: 0 | 1 | 2 = code === 0 ? 0 : code === -1744 ? 2 : 1,
  ) {}
  async AXIsProcessTrusted() { return this.code === 0; }
  async CGPreflightScreenCaptureAccess() { return this.code === 0; }
  async IOHIDCheckAccess(): Promise<0 | 1 | 2> { return this.iohid; }
  async AEDeterminePermissionToAutomateTarget(_target: string, askUserIfNeeded: boolean) {
    if (askUserIfNeeded) this.promptingCalls++;
    return this.code;
  }
  async CGRequestScreenCaptureAccess() { this.promptingCalls++; }
  async IOHIDRequestAccess() { this.promptingCalls++; }
  async requestAccessibility() { this.promptingCalls++; }
}

const factories = {
  accessibility: accessibilityProbe,
  screen_recording: screenRecordingProbe,
  input_monitoring: inputMonitoringProbe,
  automation: (bridge: PassiveBridge | null) => automationProbe(bridge, 'com.apple.Calendar'),
};

describe('diagnosis never prompts', () => {
  for (const [name, factory] of Object.entries(factories)) {
    if (name === 'input_monitoring') {
      it.each(iohidFixtures)('input_monitoring × iohid($iohid) → prompting calls = 0', async ({ iohid, status }) => {
        const native = new NativeFake(0, iohid);
        const result = await factory(native)();
        expect(native.promptingCalls).toBe(0);
        expect(result).toEqual({ status });
        process.stdout.write(`input_monitoring × iohid(${iohid}) → status=${result.status}, promptingCalls=${native.promptingCalls}\n`);
      });
    } else {
      it.each(fixtures)(`${name} × code($code) → prompting calls = 0`, async ({ code, iohid, status }) => {
        const native = new NativeFake(code, iohid);
        const result = await factory(native)();
        expect(native.promptingCalls).toBe(0);
        expect(result.status).toBe(name === 'automation' ? status : code === 0 ? 'granted' : 'denied');
        process.stdout.write(`${name} × code(${code}) → prompting calls = ${native.promptingCalls}\n`);
      });
    }
    it(`${name}: absence and native failures leave distinct warnings`, async () => {
      logs.warn.mockClear();
      const absent = `probe_unavailable:${name}:no_native_bridge`;
      expect(await factory(null)()).toEqual({ status: 'unavailable', reason: absent });
      expect(logs.warn).toHaveBeenCalledWith(absent);
      process.stdout.write(`warn assertion: ${absent}\n`);
      const broken = new NativeFake(0);
      vi.spyOn(broken, 'AXIsProcessTrusted').mockRejectedValue(new Error('native_failure'));
      vi.spyOn(broken, 'CGPreflightScreenCaptureAccess').mockRejectedValue(new Error('native_failure'));
      vi.spyOn(broken, 'IOHIDCheckAccess').mockRejectedValue(new Error('native_failure'));
      vi.spyOn(broken, 'AEDeterminePermissionToAutomateTarget').mockRejectedValue(new Error('native_failure'));
      const failed = `probe_unavailable:${name}:native_error`;
      expect(await factory(broken)()).toEqual({ status: 'unavailable', reason: failed });
      expect(logs.warn).toHaveBeenCalledWith(failed);
      process.stdout.write(`warn assertion: ${failed}\n`);
    });
  }

  it('input_monitoring invalid native code degrades to native_error with 0 prompting calls', async () => {
    logs.warn.mockClear();
    const malformed = new NativeFake(0);
    vi.spyOn(malformed, 'IOHIDCheckAccess').mockResolvedValue(99 as unknown as 0 | 1 | 2);
    expect(await inputMonitoringProbe(malformed)()).toEqual({
      status: 'unavailable',
      reason: 'probe_unavailable:input_monitoring:native_error',
    });
    expect(malformed.promptingCalls).toBe(0);
    expect(logs.warn).toHaveBeenCalledWith('probe_unavailable:input_monitoring:native_error');
  });

  it('installed IPC act mints before prompting exactly once; replay, expiry and forgery reject', async () => {
    let handler: HandlerFn | undefined;
    const install = vi.spyOn(ipcHost, 'handle').mockImplementation((_channel, fn) => { handler = fn; });
    const mint = vi.spyOn(grants, 'mintClickToken');
    let time = 100;
    let calls = 0;
    const bridge: PromptingBridge = {
      requestAccessibility: async () => { throw new Error('wrong_grant'); },
      CGRequestScreenCaptureAccess: async () => { throw new Error('wrong_grant'); },
      IOHIDRequestAccess: async () => { throw new Error('wrong_grant'); },
      AEDeterminePermissionToAutomateTarget: async (target, ask) => {
        expect(mint).toHaveReturnedWith(expect.objectContaining({ noticeId: 'current', issuedAt: 100 }));
        expect(target).toBe('com.apple.Calendar');
        expect(ask).toBe(true);
        calls++;
      },
    };
    const notice: EnvAssistNotice = {
      id: 'current', sessionId: 'session', runId: 'run', class: 'perm_automation', phase: 'needs_user',
      sentenceKey: 'env.sentence.calendar', target: { id: 'com.apple.Calendar', labelKey: 'calendar' },
      action: { kind: 'request_grant', labelKey: 'env.allow.calendar', payload: { pane: 'automation' } },
      resume: { mode: 'manual' }, updatedAt: 1,
    };
    const deps = { available: () => false, open: vi.fn(), findNotice: async () => notice,
      passiveBridge: new NativeFake(0), grantBridge: bridge, now: () => time };
    registerEnvAssistHandlers(deps);
    const payload = { noticeId: 'current', actionKind: 'request_grant', payload: { pane: 'automation' as const } };
    expect(await handler!({} as never, { action: 'act', payload })).toMatchObject({ data: { status: 'checked', outcome: { status: 'granted' } } });
    expect(mint).toHaveBeenCalledExactlyOnceWith('current', deps.now);
    expect(calls).toBe(1);
    const token = mint.mock.results[0].value;
    expect(await grants.requestGrant(token, payload.payload, bridge, deps.now)).toBe('rejected');
    const expired = grants.mintClickToken('current', deps.now);
    time += 30_000;
    expect(await grants.requestGrant(expired, payload.payload, bridge, deps.now)).toBe('rejected');
    time = 100;
    expect(await grants.requestGrant(expired, payload.payload, bridge, deps.now)).toBe('rejected');
    expect(await grants.requestGrant({ ...token }, payload.payload, bridge, deps.now)).toBe('rejected');
    expect(await grants.requestGrant(undefined as never, payload.payload, bridge)).toBe('rejected');
    if (process.env.ENV_ASSIST_TYPE_TEST === 'compile-only') {
      // @ts-expect-error Prompting-only bridges are not passive probe inputs.
      accessibilityProbe(bridge);
      // @ts-expect-error Prompting-only bridges are not passive probe inputs.
      screenRecordingProbe(bridge);
      // @ts-expect-error Prompting-only bridges are not passive probe inputs.
      inputMonitoringProbe(bridge);
      // @ts-expect-error Prompting-only bridges are not passive probe inputs.
      automationProbe(bridge, 'com.apple.Calendar');
      // @ts-expect-error A grant cannot be requested without a ClickToken.
      await grants.requestGrant(undefined, payload.payload, bridge);
      // @ts-expect-error A plain object cannot forge the unique-symbol brand.
      await grants.requestGrant({ noticeId: 'current', issuedAt: 100 }, payload.payload, bridge);
    }
    expect(calls).toBe(1);
    process.stdout.write('prompting calls = 1, token minted before the call\n');
    registerEnvAssistHandlers({ ...deps, grantBridge: null, passiveBridge: null });
    expect(await handler!({} as never, { action: 'act', payload })).toMatchObject({ data: { status: 'not_available', outcome: { status: 'unavailable' } } });
    expect(calls).toBe(1);
    mint.mockRestore(); install.mockRestore();
  });

  it('installed IPC act for inputMonitoring routes to IOHIDRequestAccess + IOHIDCheckAccess, never automation; null bridge and unsupported panes fail closed', async () => {
    let handler: HandlerFn | undefined;
    const install = vi.spyOn(ipcHost, 'handle').mockImplementation((_channel, fn) => { handler = fn; });
    const mint = vi.spyOn(grants, 'mintClickToken');
    const order: string[] = [];
    let iohidRequestCalls = 0;
    let iohidCheckCalls = 0;
    let automationCalls = 0;

    // Set automation code=0 ('granted') and IOHID code=2 ('undecided') so misrouting to automationProbe produces the wrong outcome too.
    const passive = new NativeFake(0, 2);
    vi.spyOn(passive, 'IOHIDCheckAccess').mockImplementation(async () => {
      iohidCheckCalls++;
      order.push('IOHIDCheckAccess');
      return 2;
    });
    vi.spyOn(passive, 'AEDeterminePermissionToAutomateTarget').mockImplementation(async () => {
      automationCalls++;
      order.push('AEDeterminePermissionToAutomateTarget(false)');
      return 0;
    });

    const grantBridge: PromptingBridge = {
      requestAccessibility: async () => { throw new Error('wrong_grant'); },
      CGRequestScreenCaptureAccess: async () => { throw new Error('wrong_grant'); },
      IOHIDRequestAccess: async () => {
        expect(mint).toHaveReturnedWith(expect.objectContaining({ noticeId: 'inputmon-notice', issuedAt: 200 }));
        iohidRequestCalls++;
        order.push('IOHIDRequestAccess');
      },
      AEDeterminePermissionToAutomateTarget: async () => {
        automationCalls++;
        order.push('AEDeterminePermissionToAutomateTarget(true)');
      },
    };

    const notice: EnvAssistNotice = {
      id: 'inputmon-notice', sessionId: 'session', runId: 'run', class: 'perm_input_monitoring', phase: 'needs_user',
      sentenceKey: 'env.sentence.inputMonitoring',
      action: { kind: 'request_grant', labelKey: 'env.allow.inputMonitoring', payload: { pane: 'inputMonitoring' } },
      resume: { mode: 'manual' }, updatedAt: 1,
    };
    const deps = {
      available: () => false, open: vi.fn(), findNotice: async (id: string) => id === notice.id ? notice : undefined,
      passiveBridge: passive, grantBridge, now: () => 200,
    };
    registerEnvAssistHandlers(deps);

    const payload = { noticeId: 'inputmon-notice', actionKind: 'request_grant' as const, payload: { pane: 'inputMonitoring' as const } };
    const clickRes = await handler!({} as never, { action: 'act', payload });
    expect(clickRes).toMatchObject({ success: true, data: { status: 'checked', outcome: { status: 'undecided' } } });
    expect(mint).toHaveBeenCalledExactlyOnceWith('inputmon-notice', deps.now);
    expect(iohidRequestCalls).toBe(1);
    expect(iohidCheckCalls).toBe(1);
    expect(automationCalls).toBe(0);
    expect(order).toEqual(['IOHIDRequestAccess', 'IOHIDCheckAccess']);
    process.stdout.write(`click path inputMonitoring: IOHIDRequestAccess=${iohidRequestCalls}, IOHIDCheckAccess=${iohidCheckCalls}, AEDeterminePermissionToAutomateTarget=${automationCalls}\n`);

    // (c) null bridge through installed IPC handler -> unavailable with probe_unavailable:input_monitoring:no_native_bridge + warn log
    logs.warn.mockClear();
    registerEnvAssistHandlers({ ...deps, passiveBridge: null, grantBridge: null });
    const nullRes = await handler!({} as never, { action: 'act', payload });
    expect(nullRes).toMatchObject({
      success: true,
      data: {
        status: 'not_available',
        outcome: { status: 'unavailable', reason: 'probe_unavailable:input_monitoring:no_native_bridge' },
      },
    });
    expect(logs.warn).toHaveBeenCalledWith('probe_unavailable:input_monitoring:no_native_bridge');

    // (d) unsupported pane is rejected with zero native calls (both at schema gate and inside route before requestGrant)
    let nativeCallsOnUnsupported = 0;
    const countingPassive: PassiveBridge = {
      AXIsProcessTrusted: async () => { nativeCallsOnUnsupported++; return true; },
      CGPreflightScreenCaptureAccess: async () => { nativeCallsOnUnsupported++; return true; },
      IOHIDCheckAccess: async () => { nativeCallsOnUnsupported++; return 0; },
      AEDeterminePermissionToAutomateTarget: async () => { nativeCallsOnUnsupported++; return 0; },
    };
    const countingGrant: PromptingBridge = {
      requestAccessibility: async () => { nativeCallsOnUnsupported++; },
      CGRequestScreenCaptureAccess: async () => { nativeCallsOnUnsupported++; },
      IOHIDRequestAccess: async () => { nativeCallsOnUnsupported++; },
      AEDeterminePermissionToAutomateTarget: async () => { nativeCallsOnUnsupported++; },
    };
    const unsupportedNotice: EnvAssistNotice = {
      ...notice,
      id: 'notifications-notice',
      class: 'perm_notifications',
      action: { kind: 'request_grant', labelKey: 'env.allow.notifications', payload: { pane: 'notifications' } },
    };
    mint.mockClear();
    registerEnvAssistHandlers({
      ...deps,
      findNotice: async (id: string) => id === unsupportedNotice.id ? unsupportedNotice : undefined,
      passiveBridge: countingPassive,
      grantBridge: countingGrant,
    });
    const unsupportedPayload = { noticeId: 'notifications-notice', actionKind: 'request_grant', payload: { pane: 'notifications' } };
    expect(await handler!({} as never, { action: 'act', payload: unsupportedPayload })).toMatchObject({
      success: true,
      data: { status: 'rejected' },
    });
    expect(nativeCallsOnUnsupported).toBe(0);
    expect(mint).not.toHaveBeenCalled();

    // Even if schema validation bypassed/expanded for another contract pane, route rejects BEFORE mintClickToken / requestGrant / automationProbe
    const bypassParse = vi.spyOn(EnvAssistSchemas.act, 'safeParse').mockReturnValueOnce({
      success: true,
      data: unsupportedPayload as unknown as ReturnType<typeof EnvAssistSchemas.act.parse>,
    });
    expect(await handler!({} as never, { action: 'act', payload: unsupportedPayload })).toMatchObject({
      success: true,
      data: { status: 'rejected' },
    });
    expect(nativeCallsOnUnsupported).toBe(0);
    expect(mint).not.toHaveBeenCalled();
    bypassParse.mockRestore();

    mint.mockRestore();
    install.mockRestore();
  });
});
