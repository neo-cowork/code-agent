// 并发弹出的同类卡：在一张上点「本次任务内允许」，其余被授权覆盖的卡自动放行（11-17 真机：连弹三张查看日程）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../src/shared/contract';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn(), retractNeedsInput: vi.fn() },
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { bindToolGrantDatabase } from '../../../src/host/permissions/toolGrantStore';

const settings = (): AppSettings => ({
  permissions: { autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [], devModeAutoApprove: false },
} as unknown as AppSettings);

function island(onEvent = vi.fn()) {
  return new OrchestratorPermissionIsland({
    getSettings: settings, isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main',
    hasApprovalUi: () => true, onEvent,
  } as never);
}
const ask = (i: OrchestratorPermissionIsland, sessionId: string, details: Record<string, unknown>, tool = 'calendar') =>
  i.requestPermission({ type: 'command', tool, details, sessionId } as never);
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => bindToolGrantDatabase(null, true));

describe('授权覆盖同时弹出的兄弟卡', () => {
  it('本次任务内允许：同会话同工具、grantEligible 的卡自动放行并撤卡；其余不动', async () => {
    const onEvent = vi.fn();
    const i = island(onEvent);
    const first = ask(i, 's1', { grantEligible: true });
    const sibling = ask(i, 's1', { grantEligible: true });
    const forced = ask(i, 's1', {});                              // 询问时有强制确认（未标 grantEligible）
    const otherTool = ask(i, 's1', { grantEligible: true }, 'calendar_create_event');
    const otherSession = ask(i, 's2', { grantEligible: true });
    await tick();
    const [r1, r2, r3, r4, r5] = i.listPendingRequests();
    expect(i.handlePermissionResponse(r1.id, 'allow_run')).toBe('delivered');
    await expect(first).resolves.toMatchObject({ approved: true });
    await expect(sibling).resolves.toMatchObject({ approved: true });
    expect(onEvent).toHaveBeenCalledWith({ type: 'permission_request', data: expect.objectContaining({ id: r2.id, resolved: true }) });
    expect(i.listPendingRequests().map((r) => r.id)).toEqual([r3.id, r4.id, r5.id]);
    i.drainPendingPermissions();
    await Promise.all([forced, otherTool, otherSession]);
  });

  it('允许一次不铸权，兄弟卡照旧等人', async () => {
    const i = island();
    const first = ask(i, 's1', { grantEligible: true });
    const sibling = ask(i, 's1', { grantEligible: true });
    await tick();
    const [r1, r2] = i.listPendingRequests();
    i.handlePermissionResponse(r1.id, 'allow');
    await first;
    expect(i.listPendingRequests().map((r) => r.id)).toEqual([r2.id]);
    i.drainPendingPermissions();
    await sibling;
  });
});
