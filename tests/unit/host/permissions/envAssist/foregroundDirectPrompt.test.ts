// ADR-090 修订（N-ENV-ASSIST-FOREGROUND-DIRECT-PROMPT）：用户本人前台这一轮碰到日历「未决定」，直接弹一次系统框；
// 允许 → 同一次工具调用当轮重做、没有卡片；后台 / 无人值守 / 拒绝 → 照旧失败出卡。
// 真实 toolResolver + 真实日历工具模块 + 真实原生连接器，只在原生桥边界放假桥。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtocolRegistry } from '../../../../../src/host/tools/protocolRegistry';
import { getToolResolver } from '../../../../../src/host/tools/dispatch/toolResolver';
import { getConnectorRegistry } from '../../../../../src/host/connectors/registry';
import { resetCalendarConnectorReadiness } from '../../../../../src/host/connectors/native/calendar';
import type { ToolContext } from '../../../../../src/host/tools/types';
import { calendarSchema } from '../../../../../src/host/tools/modules/connectors/calendar.schema';

const { fake } = await vi.hoisted(async () => ({ fake: (await import('../../../connectors/fakeCalendarBridge')).createFakeCalendarBridge() }));
const mocks = vi.hoisted(() => ({ unattended: new Set<string>(), grant: vi.fn() }));

vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', async (orig) => ({
  ...(await orig<object>()),
  resolveShellBridgeClientFromEnv: () => fake.client,
}));
vi.mock('../../../../../src/host/permissions/modes', async (orig) => ({
  ...(await orig<object>()),
  getPermissionModeManager: () => ({ isUnattendedSession: (id?: string) => !!id && mocks.unattended.has(id) }),
}));
vi.mock('../../../../../src/host/ipc/envAssist.ipc', () => ({ grantCalendarForForegroundRequest: mocks.grant }));

const { useDarwinPlatform } = await import('../../../connectors/fakeCalendarBridge');
useDarwinPlatform();

const run = (ctx: Partial<ToolContext>) => getToolResolver().execute('calendar', { action: 'list_calendars' }, {
  workingDirectory: '/tmp', requestPermission: vi.fn(async () => true), abortSignal: new AbortController().signal,
  currentToolCallId: 'call-1', sessionId: 's1', ...ctx,
} as unknown as ToolContext);

describe('foreground user request on an undecided calendar prompts directly', () => {
  beforeEach(() => {
    fake.reset();
    fake.state.status = 0; // 未决定：原生层读写一律 403 calendar_not_authorized
    mocks.unattended.clear();
    mocks.grant.mockReset().mockImplementation(async () => { fake.state.status = 3; return 'granted'; });
    resetCalendarConnectorReadiness();
    const registry = getProtocolRegistry();
    if (!registry.has(calendarSchema.name)) {
      registry.register(calendarSchema, async () => (await import('../../../../../src/host/tools/modules/connectors/calendar')).calendarModule);
    }
    getConnectorRegistry().configure(['calendar']);
  });

  it('foreground + undecided → one direct dialog, the same call re-runs and succeeds (no card)', async () => {
    const result = await run({ foregroundToolFace: true });
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(mocks.grant).toHaveBeenCalledWith('call-1', expect.any(AbortSignal));
    expect(result.success).toBe(true);
    expect(result.output).toContain('Work');
  });

  it('the re-run reuses the approval already given for this call (no second 「允许一次」)', async () => {
    const baselineAsk = vi.fn(async () => true);
    fake.state.status = 3;
    await run({ foregroundToolFace: true, requestPermission: baselineAsk });
    fake.state.status = 0;
    resetCalendarConnectorReadiness();
    const ask = vi.fn(async () => true);
    const result = await run({ foregroundToolFace: true, requestPermission: ask });
    expect(result.success).toBe(true);
    expect(ask.mock.calls.length).toBe(baselineAsk.mock.calls.length);
  });

  it('not a foreground user turn (background / sub-agent) → no dialog, ordinary not_authorized failure', async () => {
    const result = await run({ foregroundToolFace: false });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('not_authorized');
  });

  it('foreground face but an unattended session (cron / channel) → no dialog', async () => {
    mocks.unattended.add('s1');
    const result = await run({ foregroundToolFace: true });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(result.metadata?.code).toBe('not_authorized');
  });

  it('user refuses in the dialog → the call fails as before so the card can take over', async () => {
    mocks.grant.mockImplementation(async () => { fake.state.status = 2; return 'denied'; });
    const result = await run({ foregroundToolFace: true });
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('not_authorized');
  });
});
