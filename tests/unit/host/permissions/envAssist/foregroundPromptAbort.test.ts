import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtocolRegistry } from '../../../../../src/host/tools/protocolRegistry';
import { getToolResolver } from '../../../../../src/host/tools/dispatch/toolResolver';
import { getConnectorRegistry } from '../../../../../src/host/connectors/registry';
import { resetCalendarConnectorReadiness } from '../../../../../src/host/connectors/native/calendar';
import type { ToolContext } from '../../../../../src/host/tools/types';
import { calendarSchema } from '../../../../../src/host/tools/modules/connectors/calendar.schema';
import { askCalendarOnce } from '../../../../../src/host/permissions/envAssist/calendarSetting';
import { calendarAccess } from '../../../../../src/host/permissions/envAssist/probes/passiveProbes';
import { createShellPassiveBridge } from '../../../../../src/host/permissions/envAssist/probes/shellPassiveBridge';
import * as calendarGrant from '../../../../../src/host/permissions/envAssist/calendarGrant';
import * as grantBoundary from '../../../../../src/host/permissions/envAssist/grants/requestGrant';
import * as logging from '../../../../../src/host/services/infra/logger';
import { ENV_ASSIST_CALENDAR_POLL_MS } from '../../../../../src/shared/constants/envAssist';

const { fake } = await vi.hoisted(async () => ({ fake: (await import('../../../connectors/fakeCalendarBridge')).createFakeCalendarBridge() }));
vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', async (orig) => ({
  ...(await orig<object>()), resolveShellBridgeClientFromEnv: () => fake.client,
}));
const { useDarwinPlatform } = await import('../../../connectors/fakeCalendarBridge');
useDarwinPlatform();

const run = (signal: AbortSignal) => getToolResolver().execute('calendar', { action: 'list_calendars' }, {
  workingDirectory: '/tmp', requestPermission: async () => true, abortSignal: signal,
  foregroundToolFace: true, currentToolCallId: 'abort-calendar', sessionId: 'abort-session', runId: 'abort-run',
} as unknown as ToolContext);

beforeEach(() => {
  fake.reset();
  fake.state.status = 0;
  resetCalendarConnectorReadiness();
  const registry = getProtocolRegistry();
  if (!registry.has(calendarSchema.name)) {
    registry.register(calendarSchema, async () => (await import('../../../../../src/host/tools/modules/connectors/calendar')).calendarModule);
  }
  getConnectorRegistry().configure(['calendar']);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('foreground dialog Stop through the real resolver, grant and shared poll', () => {
  it('① Stop resolves ABORTED in <1000ms; ② late grant settles once without another dialog; ③ a surviving waiter gets granted', async () => {
    // All spies call through. Only the native shell boundary is replaced.
    const info = vi.spyOn(Object.getPrototypeOf(logging.logger) as typeof logging.logger, 'info');
    const settle = vi.spyOn(calendarGrant, 'settleCalendarGranted');
    const request = vi.spyOn(grantBoundary, 'requestGrant');
    const controller = new AbortController();
    const execution = run(controller.signal);
    await vi.waitFor(() => expect(fake.state.grants).toBe(1));
    expect(ENV_ASSIST_CALENDAR_POLL_MS).toBe(1000);
    const prompt = vi.fn(async () => 'requested' as const);
    const survivor = askCalendarOnce({ access: () => calendarAccess(createShellPassiveBridge(fake.client)), prompt });
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith('Calendar ask: joining the dialog already waiting for an answer'));
    const reads = fake.paths().filter((p) => p === '/v1/read/calendars').length;
    let survivorAfterStop: ReturnType<typeof askCalendarOnce> | undefined;
    const started = performance.now();
    controller.abort();
    // A bounded observation prevents the reverse mutation from hanging for the 60s window.
    const result = await Promise.race([execution, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1100))]);
    const elapsed = performance.now() - started;
    try {
      expect(elapsed).toBeLessThan(1000);
      expect(result).toMatchObject({ success: false, metadata: { code: 'ABORTED' } });
      expect(fake.state.status).toBe(0);
      expect(info).toHaveBeenCalledWith('Calendar foreground request: stopped while waiting', { prompted: true });
      expect(settle).not.toHaveBeenCalled();
      const lateJoiner = askCalendarOnce({ access: () => calendarAccess(createShellPassiveBridge(fake.client)), prompt });
      // Store the promise for the post-grant assertion without blocking this abort assertion.
      survivorAfterStop = lateJoiner;
      process.stdout.write(`① elapsed=${elapsed.toFixed(2)}ms <1000ms; success=false code=ABORTED; poll interval=${ENV_ASSIST_CALENDAR_POLL_MS}ms\n`);
      process.stdout.write(`① logger spy: ${JSON.stringify(info.mock.calls.find(([message]) => message === 'Calendar foreground request: stopped while waiting'))}\n`);
    } finally {
      fake.state.status = 3;
      await survivor;
      await execution;
    }
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
    expect(settle).toHaveBeenCalledWith('foreground_request');
    expect(request).toHaveBeenCalledTimes(1);
    expect(fake.state.grants).toBe(1);
    expect(await survivorAfterStop).toEqual({ access: 'granted', prompted: true });
    expect(prompt).not.toHaveBeenCalled();
    expect(await survivor).toEqual({ access: 'granted', prompted: true });
    expect(fake.paths().filter((p) => p === '/v1/read/calendars')).toHaveLength(reads);
    process.stdout.write('② settleCalendarGranted(foreground_request) exactly once; requestGrant exactly once; native dialogs=1; handler not re-run\n');
    process.stdout.write('③ surviving askCalendarOnce waiter: access=granted prompted=true; own prompt calls=0\n');
  });

  it('an already aborted caller never requests a dialog', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(controller.signal);
    expect(result).toMatchObject({ success: false, metadata: { code: 'ABORTED' } });
    expect(fake.state.grants).toBe(0);
  });
});
