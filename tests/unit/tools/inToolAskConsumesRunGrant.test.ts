// 工具体内开头授权消费「本次任务内允许」（11-17 真机：读日程点了本次任务内允许仍连弹三张卡），
// 二次确认 / 子代理强制审批不消费，放行进权限账本（PR#3610 ai-review）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({ getDefinition: vi.fn(), execute: vi.fn() }));
const ledger = vi.hoisted(() => ({ appendPermissionDecision: vi.fn(), appendToolExecutionBegin: vi.fn(), appendToolExecutionComplete: vi.fn() }));
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ getDefinition: resolverState.getDefinition, execute: resolverState.execute }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => ledger }));
vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({ createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]) }));

import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { buildCanUseToolFromLegacy } from '../../../src/host/tools/dispatch/shadowAdapter';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { bindToolGrantDatabase, mintToolRunGrant } from '../../../src/host/permissions/toolGrantStore';
import type { ToolContext } from '../../../src/host/tools/types';

function markedDetails(call: (ask: ReturnType<typeof buildCanUseToolFromLegacy>) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const legacy = { workingDirectory: '/tmp', sessionId: 's1', ...extra, requestPermission: async (r: Record<string, unknown>) => { requests.push(r); return true; } } as unknown as ToolContext;
  return call(buildCanUseToolFromLegacy(legacy, 'calendar')).then(() => (requests[0].details as Record<string, unknown>).grantEligible);
}

beforeEach(() => {
  bindToolGrantDatabase(null, true);
  resetDecisionHistory();
  Object.values(ledger).forEach((f) => f.mockReset());
  resolverState.getDefinition.mockReturnValue({
    name: 'probe_tool', description: 'p', inputSchema: { type: 'object', properties: {}, required: [] }, requiresPermission: false, permissionLevel: 'read',
  });
});

describe('shadowAdapter 只给开头授权标 grantEligible（host 写，覆盖参数同名键）', () => {
  it.each([
    ['开头授权', (a: ReturnType<typeof buildCanUseToolFromLegacy>) => a('calendar', { grantEligible: false }), {}, true],
    ['二次确认（带 reason，如 git push）', (a: ReturnType<typeof buildCanUseToolFromLegacy>) => a('calendar', { grantEligible: true }, '推送代码到远程仓库'), {}, false],
    ['带 hint（forceConfirm 等）', (a: ReturnType<typeof buildCanUseToolFromLegacy>) => a('calendar', {}, undefined, { forceConfirm: true } as never), {}, false],
    ['子代理一律走审批处理器', (a: ReturnType<typeof buildCanUseToolFromLegacy>) => a('calendar', {}), { forcePermissionHandler: true }, false],
  ])('%s', async (_n, call, extra, expected) => {
    await expect(markedDetails(call, extra)).resolves.toBe(expected);
  });
});

describe('ToolExecutor 体内包装器消费授权并记账', () => {
  const body = (seen: { approved?: unknown }) => async (_n: string, _p: unknown, context: ToolContext) => {
    seen.approved = await context.requestPermission({ type: 'command', tool: 'calendar', details: { grantEligible: true } } as never);
    return { success: true, result: 'ok' };
  };

  it('本次任务内允许过 calendar：不再问人，账本记 session-allowlist', async () => {
    mintToolRunGrant('sess', 'calendar', null);
    const seen: { approved?: unknown } = {};
    resolverState.execute.mockImplementation(body(seen));
    const ask = vi.fn().mockResolvedValue(true);
    await new ToolExecutor({ requestPermission: ask, workingDirectory: '/tmp/wb' }).execute('probe_tool', {}, { sessionId: 'sess' });
    expect(seen.approved).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    const rows = ledger.appendPermissionDecision.mock.calls.map(([e]) => e as Record<string, unknown>);
    expect(rows).toEqual([expect.objectContaining({ historyOutcome: 'ask-approved', reason: 'session-allowlist', toolName: 'calendar' })]);
  });

  it('没有授权 / 别的会话：照常问人', async () => {
    mintToolRunGrant('other', 'calendar', null);
    const seen: { approved?: unknown } = {};
    resolverState.execute.mockImplementation(body(seen));
    const ask = vi.fn().mockResolvedValue(true);
    await new ToolExecutor({ requestPermission: ask, workingDirectory: '/tmp/wb' }).execute('probe_tool', {}, { sessionId: 'sess' });
    expect(ask).toHaveBeenCalledOnce();
  });
});
