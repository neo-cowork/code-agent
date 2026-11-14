// Evidence class: hermetic-protocol (fake native bridges). Not real-device proof.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessibilityProbe, automationProbe, screenRecordingProbe } from '../../../../../src/host/permissions/envAssist/probes/passiveProbes';
import type { PassiveBridge, PromptingBridge } from '../../../../../src/host/permissions/envAssist/probes/types';
import * as grants from '../../../../../src/host/permissions/envAssist/grants/requestGrant';
import { registerEnvAssistHandlers } from '../../../../../src/host/ipc/envAssist.ipc';
import type { EnvAssistNotice } from '../../../../../src/shared/contract/envAssist';
import { ipcHost, type HandlerFn } from '../../../../../src/host/platform';

vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<object>(), createLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

type Code = 0 | -1743 | -1744 | -600;
const fixtures: ReadonlyArray<{ code: Code; status: string }> = [
  { code: 0, status: 'granted' }, { code: -1743, status: 'denied' },
  { code: -1744, status: 'undecided' }, { code: -600, status: 'not_running' },
];
const TARGET = 'com.apple.Calendar';
type Pane = 'accessibility' | 'screenCapture' | 'automation';
const panes: ReadonlyArray<{ pane: Pane; klass: EnvAssistNotice['class']; probe: (b: PassiveBridge) => () => Promise<{ status: string }> }> = [
  { pane: 'accessibility', klass: 'perm_accessibility', probe: accessibilityProbe },
  { pane: 'screenCapture', klass: 'perm_screen_recording', probe: screenRecordingProbe },
  { pane: 'automation', klass: 'perm_automation', probe: (b) => automationProbe(b, TARGET) },
];

/** One native state: passive reads and prompting calls are counted per method. */
class NativeFake {
  prompting: Record<'CGRequestScreenCaptureAccess' | 'requestAccessibility' | 'AEDeterminePermissionToAutomateTarget', number> =
    { CGRequestScreenCaptureAccess: 0, requestAccessibility: 0, AEDeterminePermissionToAutomateTarget: 0 };
  constructor(public code: Code) {}
  get total() { return Object.values(this.prompting).reduce((a, b) => a + b, 0); }
  passive: PassiveBridge = {
    AXIsProcessTrusted: async () => this.code === 0,
    CGPreflightScreenCaptureAccess: async () => this.code === 0,
    AEDeterminePermissionToAutomateTarget: async (_t, ask) => {
      if ((ask as boolean) === true) this.prompting.AEDeterminePermissionToAutomateTarget++;
      return this.code;
    },
  };
  grant: PromptingBridge = {
    requestAccessibility: async () => { this.prompting.requestAccessibility++; },
    CGRequestScreenCaptureAccess: async () => { this.prompting.CGRequestScreenCaptureAccess++; },
    AEDeterminePermissionToAutomateTarget: async (_t, ask) => {
      if (ask) this.prompting.AEDeterminePermissionToAutomateTarget++;
    },
  };
}

const notice = (pane: Pane, klass: EnvAssistNotice['class'], kind: 'request_grant' | 'open_settings_pane', over: Partial<EnvAssistNotice> = {}): EnvAssistNotice => ({
  id: `n-${pane}-${kind}`, sessionId: 's', runId: 'r', class: klass, phase: 'needs_user', sentenceKey: 'env.sentence',
  target: { id: TARGET, labelKey: 'calendar' }, action: { kind, labelKey: 'env.allow', payload: { pane } },
  resume: { mode: 'manual' }, updatedAt: 1, ...over,
});

describe('envAssist IPC contract (hermetic-protocol, fake bridges)', () => {
  let handler: HandlerFn | undefined;
  let mint: ReturnType<typeof vi.spyOn<typeof grants, 'mintClickToken'>>;
  beforeEach(() => {
    vi.spyOn(ipcHost, 'handle').mockImplementation((_c, fn) => { handler = fn; });
    mint = vi.spyOn(grants, 'mintClickToken');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const install = (fake: NativeFake, notices: EnvAssistNotice[], open = vi.fn(async () => true)) => {
    registerEnvAssistHandlers({
      available: () => true, open, findNotice: async (id) => notices.find((n) => n.id === id),
      passiveBridge: fake.passive, grantBridge: fake.grant,
    });
    return (action: string, payload?: unknown) => handler!({} as never, { action, payload });
  };

  for (const { pane, klass, probe } of panes) {
    it.each(fixtures)(`${pane} × code($code): diagnosis/getAvailability/open_settings_pane never prompt; one click prompts once`, async ({ code }) => {
      const fake = new NativeFake(code);
      const open = vi.fn(async () => true);
      const call = install(fake, [notice(pane, klass, 'request_grant'), notice(pane, klass, 'open_settings_pane')], open);

      // Clause 1: passive diagnosis, getAvailability, open_settings_pane.
      const first = await probe(fake.passive)();
      expect(await call('getAvailability')).toMatchObject({ data: { available: true } });
      expect(await call('act', { noticeId: `n-${pane}-open_settings_pane`, actionKind: 'open_settings_pane', payload: { pane } }))
        .toMatchObject({ data: { status: 'opened' } });
      expect(open).toHaveBeenCalledWith(pane);
      expect(fake.total).toBe(0);
      expect(mint).toHaveBeenCalledTimes(0);
      process.stdout.write(`[clause1] ${pane} × code(${code}) diagnosis=${first.status} prompting=${fake.total} mintClickToken=${mint.mock.calls.length}\n`);

      // Clause 2: exactly one click.
      const res = await call('act', { noticeId: `n-${pane}-request_grant`, actionKind: 'request_grant', payload: { pane } });
      expect(res).toMatchObject({ data: { status: 'checked', outcome: { status: code === 0 ? 'granted' : pane === 'automation' ? fixtures.find((f) => f.code === code)!.status : 'denied' } } });
      expect(fake.total).toBe(1);
      expect(mint).toHaveBeenCalledTimes(1);
      const afterClick = fake.total;
      await probe(fake.passive)();
      expect(fake.total - afterClick).toBe(0);
      fake.code = 0;
      expect((await probe(fake.passive)()).status).toBe('granted');
      expect(fake.total).toBe(1);
      process.stdout.write(`[clause2] ${pane} × code(${code}) click prompting=${afterClick} mintClickToken=${mint.mock.calls.length} re-diagnosis delta=${fake.total - afterClick} after-grant status=granted\n`);
    });
  }

  it('mismatching pane, wrong phase, unknown notice, input monitoring and replayed token never prompt', async () => {
    const fake = new NativeFake(-1744);
    const notices = [
      notice('accessibility', 'perm_accessibility', 'request_grant'),
      notice('screenCapture', 'perm_screen_recording', 'request_grant', { id: 'wrong-phase', phase: 'resolved' }),
      notice('automation', 'perm_automation', 'request_grant', { id: 'no-target', target: undefined }),
    ];
    const call = install(fake, notices);
    const rejected = { data: { status: 'rejected' } };
    expect(await call('act', { noticeId: 'n-accessibility-request_grant', actionKind: 'request_grant', payload: { pane: 'screenCapture' } })).toMatchObject(rejected);
    expect(await call('act', { noticeId: 'n-accessibility-request_grant', actionKind: 'open_settings_pane', payload: { pane: 'accessibility' } })).toMatchObject(rejected);
    expect(await call('act', { noticeId: 'wrong-phase', actionKind: 'request_grant', payload: { pane: 'screenCapture' } })).toMatchObject(rejected);
    expect(await call('act', { noticeId: 'no-target', actionKind: 'request_grant', payload: { pane: 'automation' } })).toMatchObject(rejected);
    expect(await call('act', { noticeId: 'missing', actionKind: 'request_grant', payload: { pane: 'accessibility' } })).toMatchObject(rejected);
    // Input monitoring has no passive probe on this base and the IPC schema does not admit the pane.
    expect(await call('act', { noticeId: 'n-accessibility-request_grant', actionKind: 'request_grant', payload: { pane: 'inputMonitoring' } })).toMatchObject(rejected);
    expect(fake.total).toBe(0);
    expect(mint).toHaveBeenCalledTimes(0);

    const ok = { noticeId: 'n-accessibility-request_grant', actionKind: 'request_grant', payload: { pane: 'accessibility' } };
    expect(await call('act', ok)).toMatchObject({ data: { status: 'checked' } });
    expect(fake.total).toBe(1);
    const token = mint.mock.results[0].value;
    expect(await grants.requestGrant(token, { pane: 'accessibility' }, fake.grant)).toBe('rejected');
    expect(fake.total).toBe(1);
    process.stdout.write(`[rejects] mismatch/phase/target/unknown/inputMonitoring/replay → extra prompting=${fake.total - 1}\n`);
  });
});
