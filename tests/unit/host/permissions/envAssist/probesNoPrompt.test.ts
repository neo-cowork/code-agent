import { describe, expect, it, vi } from 'vitest';
import { accessibilityProbe, automationProbe, screenRecordingProbe } from '../../../../../src/host/permissions/envAssist/probes/passiveProbes';
import type { PassiveBridge, PromptingBridge } from '../../../../../src/host/permissions/envAssist/probes/types';
import * as grants from '../../../../../src/host/permissions/envAssist/grants/requestGrant';
import { registerEnvAssistHandlers } from '../../../../../src/host/ipc/envAssist.ipc';
import type { EnvAssistNotice } from '../../../../../src/shared/contract/envAssist';
import { ipcHost, type HandlerFn } from '../../../../../src/host/platform';

const logs = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => ({ ...await importOriginal<object>(), createLogger: () => logs }));

// Native Apple-event OSStatus fixtures: no invented success objects.
const fixtures = [
  { code: 0, status: 'granted' },
  { code: -1743, status: 'denied' },
  { code: -1744, status: 'undecided' },
  { code: -600, status: 'not_running' },
] as const;

class NativeFake implements PassiveBridge {
  promptingCalls = 0;
  constructor(readonly code: typeof fixtures[number]['code']) {}
  async AXIsProcessTrusted() { return this.code === 0; }
  async CGPreflightScreenCaptureAccess() { return this.code === 0; }
  async AEDeterminePermissionToAutomateTarget(_target: string, askUserIfNeeded: boolean) {
    if (askUserIfNeeded) this.promptingCalls++;
    return this.code;
  }
  async CGRequestScreenCaptureAccess() { this.promptingCalls++; }
  async requestAccessibility() { this.promptingCalls++; }
}

const factories = { accessibility: accessibilityProbe, screen_recording: screenRecordingProbe, automation: (bridge: PassiveBridge | null) => automationProbe(bridge, 'com.apple.Calendar') };

describe('diagnosis never prompts', () => {
  for (const [name, factory] of Object.entries(factories)) {
    it.each(fixtures)(`${name} × code($code) → prompting calls = 0`, async ({ code, status }) => {
      const native = new NativeFake(code);
      const result = await factory(native)();
      expect(native.promptingCalls).toBe(0);
      expect(result.status).toBe(name === 'automation' ? status : code === 0 ? 'granted' : 'denied');
      process.stdout.write(`${name} × code(${code}) → prompting calls = ${native.promptingCalls}\n`);
    });
    it(`${name}: absence and native failures leave distinct warnings`, async () => {
      logs.warn.mockClear();
      const absent = `probe_unavailable:${name}:no_native_bridge`;
      expect(await factory(null)()).toEqual({ status: 'unavailable', reason: absent });
      expect(logs.warn).toHaveBeenCalledWith(absent);
      process.stdout.write(`warn assertion: ${absent}\n`);
      const broken = new NativeFake(0);
      vi.spyOn(broken, 'AXIsProcessTrusted').mockRejectedValue(new Error('native_failure'));
      vi.spyOn(broken, 'CGPreflightScreenCaptureAccess').mockRejectedValue(new Error('native_failure'));
      vi.spyOn(broken, 'AEDeterminePermissionToAutomateTarget').mockRejectedValue(new Error('native_failure'));
      const failed = `probe_unavailable:${name}:native_error`;
      expect(await factory(broken)()).toEqual({ status: 'unavailable', reason: failed });
      expect(logs.warn).toHaveBeenCalledWith(failed);
      process.stdout.write(`warn assertion: ${failed}\n`);
    });
  }

  it('installed IPC act mints before prompting exactly once; replay, expiry and forgery reject', async () => {
    let handler: HandlerFn | undefined;
    const install = vi.spyOn(ipcHost, 'handle').mockImplementation((_channel, fn) => { handler = fn; });
    const mint = vi.spyOn(grants, 'mintClickToken');
    let time = 100;
    let calls = 0;
    const bridge: PromptingBridge = {
      requestAccessibility: async () => { throw new Error('wrong_grant'); },
      CGRequestScreenCaptureAccess: async () => { throw new Error('wrong_grant'); },
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
});
