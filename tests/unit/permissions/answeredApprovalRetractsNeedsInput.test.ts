// 前台审批卡被人答复后撤回 needs-input 补提醒（11-17 真机：「有 2 条提醒」点进去都已处理完）。
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../src/shared/contract';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
const notificationMocks = vi.hoisted(() => ({ notifyNeedsInput: vi.fn(), retractNeedsInput: vi.fn() }));
vi.mock('../../../src/host/services/infra/notificationService', () => ({ notificationService: notificationMocks }));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

describe('前台审批答复撤回 needs-input', () => {
  it.each(['allow', 'deny'] as const)('%s 后按请求 id 撤回', async (response) => {
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => true,
      onEvent: vi.fn(),
    } as never);
    const pending = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/a.txt' },
      sessionId: 'fg-session',
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    const [req] = island.listPendingRequests();
    expect(req).toBeDefined();
    expect(island.handlePermissionResponse(req.id, response)).toBe('delivered');
    await pending;
    expect(notificationMocks.retractNeedsInput).toHaveBeenCalledWith(req.id);
  });
});
