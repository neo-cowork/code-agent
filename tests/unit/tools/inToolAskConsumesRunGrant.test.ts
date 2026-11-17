// 工具体内审批也消费「本次任务内允许」（11-17 真机：读日程点了本次任务内允许仍连弹三张卡）。
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCanUseToolFromLegacy } from '../../../src/host/tools/dispatch/shadowAdapter';
import { bindToolGrantDatabase, mintToolRunGrant } from '../../../src/host/permissions/toolGrantStore';
import type { ToolContext as LegacyToolContext } from '../../../src/host/tools/types';

function legacy(requests: Array<Record<string, unknown>>) {
  return {
    workingDirectory: '/tmp', sessionId: 's1', runId: 'r1',
    requestPermission: async (request: Record<string, unknown>) => { requests.push(request); return true; },
  } as unknown as LegacyToolContext;
}

beforeEach(() => bindToolGrantDatabase(null, true));

describe('工具体内审批消费已记住的工具级授权', () => {
  it('本次任务内允许过 calendar：同会话下一次体内审批不再弹卡', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const ask = buildCanUseToolFromLegacy(legacy(requests), 'calendar');
    await ask('calendar', { action: 'list_events' });
    expect(requests).toHaveLength(1);
    mintToolRunGrant('s1', 'calendar', null);
    await expect(ask('calendar', { action: 'list_events', from_local: '2026-11-19 00:00' })).resolves.toMatchObject({ allow: true, approvalSource: 'session-allowlist' });
    expect(requests).toHaveLength(1);
  });

  it('强制确认 / 别的会话 不消费；模型参数里的 grantEligible 被 host 覆盖', async () => {
    mintToolRunGrant('s1', 'calendar', null);
    const requests: Array<Record<string, unknown>> = [];
    const ask = buildCanUseToolFromLegacy(legacy(requests), 'calendar');
    await ask('calendar', { grantEligible: true }, undefined, { forceConfirm: true } as never);
    await ask('calendar', {}, undefined, { sessionId: 's2' } as never);
    expect(requests).toHaveLength(2);
    expect((requests[0].details as Record<string, unknown>).grantEligible).toBe(false);
    expect((requests[1].details as Record<string, unknown>).grantEligible).toBe(true);
  });
});
