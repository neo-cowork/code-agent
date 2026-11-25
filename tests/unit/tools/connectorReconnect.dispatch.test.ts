import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getToolResolver } from '../../../src/host/tools/dispatch/toolResolver';
import { executePocToolViaProtocol } from '../../../src/host/tools/dispatch/shadowAdapter';
import { getConnectorRegistry } from '../../../src/host/connectors/registry';
import type { Connector, ConnectorStatus } from '../../../src/host/connectors/base';
import type { ToolContext } from '../../../src/host/tools/types';
import { calendarSchema } from '../../../src/host/tools/modules/connectors/calendar.schema';
import { remindersSchema } from '../../../src/host/tools/modules/connectors/reminders.schema';
import { publishEnvAssistToolNotice } from '../../../src/host/permissions/envAssist/toolNotice';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  const availabilityLogger = original.createLogger('ConnectorAvailability');
  warn.mockImplementation(availabilityLogger.warn.bind(availabilityLogger));
  return {
    ...original,
    createLogger: (context: string) => ({
      info: vi.fn(), warn: context === 'ConnectorAvailability' ? warn : vi.fn(), error: vi.fn(), debug: vi.fn(),
    }),
  };
});

const execute = async (path: string, action: string, toolName = 'calendar') => {
  const requestPermission = vi.fn(async () => true);
  return path === 'resolver'
    ? getToolResolver().execute(toolName, { action }, {
      workingDirectory: '/tmp', requestPermission, abortSignal: new AbortController().signal,
    } as unknown as ToolContext)
    : executePocToolViaProtocol({ toolName, params: { action }, workingDirectory: '/tmp', requestPermission });
};

function registerReminders(status: ConnectorStatus) {
  const exec = vi.fn<Connector['execute']>().mockResolvedValue({ data: status });
  const getCachedStatus = vi.fn(() => status);
  getConnectorRegistry().register({
    id: 'reminders', label: 'Reminders', capabilities: status.capabilities,
    getCachedStatus, getStatus: async () => status, execute: exec,
  });
  return { exec, getCachedStatus };
}

describe('connector reconnect guidance through real protocol dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The calendar tool registers on macOS only; register the real schema and module where
    // it is missing so the dispatch wrapper is exercised on the Linux CI runner as well.
    const registry = getProtocolRegistry();
    if (!registry.has(calendarSchema.name)) {
      registry.register(calendarSchema, async () => (await import('../../../src/host/tools/modules/connectors/calendar')).calendarModule);
    }
    if (!registry.has(remindersSchema.name)) {
      registry.register(remindersSchema, async () => (await import('../../../src/host/tools/modules/connectors/reminders')).remindersModule);
    }
    getConnectorRegistry().configure([]);
  });

  it.each(['resolver', 'adapter'])('%s preserves missing-connector failure and adds a reconnect exit', async (path) => {
    const result = await execute(path, 'list_events');
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('NOT_INITIALIZED');
    expect(result.error).toContain('Capability Hub > Connectors');
    expect(result.error).not.toContain('设置 > 连接器');
    expect(result.error).not.toContain('Settings > Connectors');
    expect(result.error).toContain('日历还没有连接，所以这次看不到你的日程，请在能力中心 > 连接器打开后再试。');
    expect(result.error).toContain('never state that there are no events');
    expect(warn).toHaveBeenCalledWith('Connector call needs reconnection', expect.objectContaining({
      connectorId: 'calendar', reason: 'not-enabled-or-registered',
    }));
    expect(getConnectorRegistry().get('calendar')).toBeUndefined();
  });

  it.each(['resolver', 'adapter'])('%s adds the exit to a disconnected status without inventing authorization', async (path) => {
    const result = await execute(path, 'get_status');
    expect(result.success).toBe(true);
    expect(result.metadata?.modelGuidance).toContain('Capability Hub > Connectors');
    expect(result.metadata?.modelGuidance).not.toContain('设置 > 连接器');
    expect(result.metadata?.modelGuidance).not.toContain('Settings > Connectors');
    expect(result.metadata?.modelGuidance).toContain('complete user-facing answer is exactly this single everyday sentence');
    expect(result.metadata?.modelGuidance).not.toMatch(/not configured|Capabilities: none/i);
    expect(result.metadata?.modelGuidance).toContain('日历还没有连接，所以这次看不到你的日程，请在能力中心 > 连接器打开后再试。');
    expect(result.metadata?.modelGuidance).toContain('never state that there are no events');
    expect(result.metadata?.status).toMatchObject({ connected: false, unavailable: true });
    expect(warn).toHaveBeenCalledWith('Connector call needs reconnection', expect.objectContaining({
      connectorId: 'calendar', reason: 'status-not-connected',
    }));
  });

  describe.each(['resolver', 'adapter'])('%s Reminders read guidance', (path) => {
    const unchecked: ConnectorStatus = { connected: false, readiness: 'unchecked', capabilities: ['list_reminders'] };

    it('points an unchecked status to Check and authorization', async () => {
      registerReminders(unchecked);

      const result = await execute(path, 'get_status', 'reminders');

      expect(result.success).toBe(true);
      expect(result.metadata?.status).toEqual(unchecked);
      expect(result.metadata?.modelGuidance).toContain('还没检查提醒事项的访问权限，请在能力中心 > 连接器点‘检查’并按提示授权。');
      expect(result.metadata?.modelGuidance).toContain('Translate only that sentence for another user language (navigation: Capability Hub > Connectors, action: Check and authorize when prompted).');
      expect(result.metadata?.modelGuidance).not.toMatch(/reconnect|重新连接/i);
      expect(warn).toHaveBeenCalledWith('Connector call needs reconnection', {
        connectorId: 'reminders', toolName: 'reminders', reason: 'status-unchecked',
      });
    });

    it.each(['get_status', 'list_lists', 'list_reminders'])('probes once before %s when unchecked', async (action) => {
      const ready: ConnectorStatus = { ...unchecked, connected: true, readiness: 'ready' };
      const { exec } = registerReminders(unchecked);
      exec.mockResolvedValueOnce({ data: ready }).mockResolvedValueOnce({ data: action === 'get_status' ? ready : [] });

      const result = await execute(path, action, 'reminders');

      expect(result.success).toBe(true);
      expect(exec.mock.calls).toEqual([['probe_access', {}], [action, { action }]]);
    });

    it('shares the pending permission check across parallel reads', async () => {
      const { exec, getCachedStatus } = registerReminders(unchecked);
      const probe = Promise.withResolvers<{ data: ConnectorStatus }>();
      exec.mockImplementation((action) => action === 'probe_access' ? probe.promise : Promise.resolve({ data: [] }));

      const reads = ['list_lists', 'list_reminders'].map((action) => execute(path, action, 'reminders'));
      try {
        await vi.waitFor(() => expect(getCachedStatus).toHaveBeenCalledTimes(2));
        expect(exec.mock.calls).toEqual([['probe_access', {}]]);
      } finally {
        probe.resolve({ data: { ...unchecked, connected: true, readiness: 'ready' } });
      }

      expect((await Promise.all(reads)).every((result) => result.success)).toBe(true);
      expect(exec.mock.calls.filter(([action]) => action === 'probe_access')).toHaveLength(1);
      expect(exec.mock.calls).toHaveLength(3);
    });

    it.each([
      ['probe_access', 'Not authorized to send Apple events to Reminders. (-1743)'],
      ['list_reminders', 'Not authorized to send Apple events to Reminders. (-1743)'],
      ['probe_access', 'Not authorized to access reminders.'],
    ])('keeps Check guidance and skips the card when %s fails with %s', async (failedAction, stderr) => {
      const status = failedAction === 'probe_access' ? unchecked : { ...unchecked, connected: true, readiness: 'ready' } as const;
      const { exec } = registerReminders(status);
      exec.mockRejectedValueOnce(Object.assign(new Error('Command failed: osascript'), { stderr }));
      const result = await execute(path, 'list_reminders', 'reminders');
      const onEvent = vi.fn();
      const guidance = result.error;
      expect(result.success).toBe(false);
      expect(result.metadata?.code).toBe('not_authorized');
      expect(result.metadata?.accessProbeDenied).toBe(true);
      expect(result.metadata).not.toHaveProperty('notAppleEvents');
      expect(exec).toHaveBeenCalledExactlyOnceWith(
        failedAction, failedAction === 'probe_access' ? {} : { action: 'list_reminders' },
      );
      expect(guidance).toContain('还没有授权 Neo 访问提醒事项，请在能力中心 > 连接器点‘检查’并按提示授权。');
      await publishEnvAssistToolNotice({
        toolName: 'reminders', result, sessionId: 'reminders-denial', runId: 'read-denied', onEvent,
      });
      expect(onEvent).not.toHaveBeenCalled();
      expect(result.metadata?.envAssist).toBeUndefined();
      expect(result.error).toBe(guidance);
    });

    it('keeps the authorization error code and stops the read if the probe is denied', async () => {
      const { exec } = registerReminders(unchecked);
      exec.mockRejectedValueOnce(Object.assign(new Error('Command failed: osascript'), {
        stderr: 'Not authorized to send Apple events to Reminders. (-1743)',
      }));

      const result = await execute(path, 'list_reminders', 'reminders');

      expect(result.success).toBe(false);
      expect(result.metadata?.code).toBe('not_authorized');
      expect(result.error).toContain('还没有授权 Neo 访问提醒事项，请在能力中心 > 连接器点‘检查’并按提示授权。');
      expect(result.error).not.toMatch(/reconnect|重新连接|osascript/i);
      expect(exec.mock.calls).toEqual([['probe_access', {}]]);
      expect(warn).toHaveBeenCalledWith('Connector call needs reconnection', {
        connectorId: 'reminders', toolName: 'reminders', reason: 'access-probe-denied',
      });
    });

    it('returns the same Check guidance when get_status reads the denial saved by a previous ask', async () => {
      const { exec, getCachedStatus } = registerReminders(unchecked);
      const denied: ConnectorStatus = {
        ...unchecked, readiness: 'failed', errorCode: 'not_authorized', error: 'Reminders access denied',
      };
      exec.mockRejectedValueOnce(Object.assign(new Error('Command failed: osascript'), {
        stderr: 'Not authorized to send Apple events to Reminders. (-1743)',
      })).mockResolvedValueOnce({ data: denied });
      const first = await execute(path, 'get_status', 'reminders');
      getCachedStatus.mockReturnValue(denied);
      const second = await execute(path, 'get_status', 'reminders');

      expect(exec.mock.calls).toEqual([['probe_access', {}], ['get_status', { action: 'get_status' }]]);
      expect(first.error).toContain('Capability Hub > Connectors');
      expect(second).toMatchObject({
        success: false, error: first.error, metadata: { code: 'not_authorized', accessProbeDenied: true },
      });
    });

    it.each([
      [{ readiness: 'failed' } as const, '这次还没读到所需数据，请在能力中心 > 连接器重新连接后再试。'],
      [{ readiness: 'unavailable', unavailable: true } as const, '提醒事项还没有连接，所以这次看不到你的提醒事项，请在能力中心 > 连接器打开后再试。'],
    ])('preserves the prior output for status %j without probing', async (state, sentence) => {
      const { exec } = registerReminders({ ...unchecked, ...state });

      const result = await execute(path, 'get_status', 'reminders');

      expect(result.success).toBe(true);
      expect(result.metadata?.modelGuidance).toContain(sentence);
      expect(exec.mock.calls).toEqual([['get_status', { action: 'get_status' }]]);
      expect(warn).toHaveBeenCalledWith('Connector call needs reconnection', {
        connectorId: 'reminders', toolName: 'reminders', reason: 'status-not-connected',
      });
    });
  });
});
