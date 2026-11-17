// Evidence class: hermetic-protocol (execFile + passive TCC probe stubbed). Real dialog timing is the Dev-package run.
// N-FIX-CALENDAR-PERMISSION-DIALOG-15S-TIMEOUT: while macOS may still be asking "allow Neo to control Calendar",
// osascript blocks on the dialog, so the 15s connector budget must not apply.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  timeouts: [] as Array<number | undefined>,
  probeCode: -1744 as number,
  probedTargets: [] as string[],
  shell: true,
  outcome: { stdout: 'Home|Work\n' } as { stdout?: string; error?: Error },
}));
vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: string[], options: { timeout?: number }, callback: (error: unknown, result?: { stdout: string; stderr: string }) => void) => {
    mocks.timeouts.push(options.timeout);
    if (mocks.outcome.error) callback(mocks.outcome.error);
    else callback(null, { stdout: mocks.outcome.stdout ?? '', stderr: '' });
  },
}));
vi.mock('../../../src/host/permissions/envAssist/shellBridge/client', () => ({
  resolveShellBridgeClientFromEnv: () => (mocks.shell ? {} : null),
}));
vi.mock('../../../src/host/permissions/envAssist/probes/shellPassiveBridge', () => ({
  createShellPassiveBridge: () => ({
    AEDeterminePermissionToAutomateTarget: async (target: string, ask: boolean) => {
      expect(ask).toBe(false); // passive: never shows a dialog itself
      mocks.probedTargets.push(target);
      return mocks.probeCode;
    },
  }),
}));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

import { describeAppleScriptFailure, runAppleScript } from '../../../src/host/connectors/native/osascript';
import { APPLE_EVENTS_PERMISSION_PROMPT_TIMEOUT_MS } from '../../../src/shared/constants/envAssist';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  Object.assign(mocks, { timeouts: [], probeCode: -1744, probedTargets: [], shell: true, outcome: { stdout: 'Home|Work\n' } });
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); });

describe('AppleScript budget while the automation dialog may be showing', () => {
  it.each([
    [-1744, 'undecided (dialog will show)', APPLE_EVENTS_PERMISSION_PROMPT_TIMEOUT_MS],
    [-600, 'target not running (answer unknown until launched)', APPLE_EVENTS_PERMISSION_PROMPT_TIMEOUT_MS],
    [0, 'granted', 15_000],
    [-1743, 'refused (no dialog, fails fast)', 15_000],
  ])('probe %s (%s) → osascript timeout %s', async (code, _label, expected) => {
    mocks.probeCode = code;
    await runAppleScript(['return 1'], { permissionTarget: 'com.apple.iCal' });
    expect(mocks.probedTargets).toEqual(['com.apple.iCal']);
    expect(mocks.timeouts).toEqual([expected]);
  });

  it('no desktop shell (probe unavailable) and scripts without a target keep the ordinary budget, without probing', async () => {
    mocks.shell = false;
    vi.resetModules(); // the passive bridge is resolved once per process
    const fresh = await import('../../../src/host/connectors/native/osascript');
    await fresh.runAppleScript(['return 1'], { permissionTarget: 'com.apple.iCal' });
    await fresh.runAppleScript(['return 1']);
    expect(mocks.probedTargets).toEqual([]);
    expect(mocks.timeouts).toEqual([15_000, 15_000]);
  });

  it('② "Don\'t Allow" on the dialog (-1743) is reported as not_authorized, not timeout', async () => {
    mocks.outcome = { error: Object.assign(new Error('Command failed: osascript\nexecution error: Not authorized to send Apple events to Calendar. (-1743)'), { code: 1, stderr: 'Not authorized to send Apple events to Calendar. (-1743)' }) };
    // 日历已改走 EventKit（N-CALENDAR-ONE-PERMISSION-EVENTKIT）；预算机制本身对任何 Apple-events 目标仍成立
    const thrown = await runAppleScript(['return 1'], { permissionTarget: 'com.apple.reminders' }).then(() => undefined, (error: unknown) => error);
    expect(describeAppleScriptFailure('Reminders', thrown).code).toBe('not_authorized');
    expect(mocks.timeouts).toEqual([APPLE_EVENTS_PERMISSION_PROMPT_TIMEOUT_MS]);
  });
});
