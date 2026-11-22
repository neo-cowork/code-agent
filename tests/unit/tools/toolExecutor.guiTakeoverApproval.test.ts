// ============================================================================
// GUI 接管披露与审批共存（N-CUA-HOST-GUI-DISCLOSURE）
//
// 真 ToolExecutor：Bash 命令驱动 System Events GUI 输入（classifyShellDesktopAutomation
// 命中，与披露判定共用同一张判据表）时审批必须照常弹出——披露只加一句话，不许
// 顺带改审批/拒绝规则。对照组：安全命令不弹审批（既有行为不受影响）。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlerExecute: vi.fn(),
  getSchemas: vi.fn(),
  has: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({
    getSchemas: mocks.getSchemas,
    has: mocks.has,
    resolve: mocks.resolve,
  }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));

vi.mock('../../../src/host/tools/protocolToolRegistration', () => ({
  getProtocolToolSchemas: mocks.getSchemas,
  hasProtocolTool: mocks.has,
  resolveProtocolTool: mocks.resolve,
  registerProtocolTool: vi.fn(),
  unregisterProtocolTool: vi.fn(),
  setProtocolToolRegistryPort: vi.fn(),
}));

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: () => [],
    parseMCPToolName: () => null,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
    invalidateForPath: vi.fn(),
    invalidateForWorkspace: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { resetToolResolver } = await import('../../../src/host/tools/dispatch/toolResolver');

const GUI_KEYSTROKE_COMMAND = `osascript -e 'tell application "System Events" to tell process "Keynote" to keystroke "1"'`;

describe('GUI 接管披露 · 审批照常（真 ToolExecutor）', () => {
  beforeEach(() => {
    resetToolResolver();
    mocks.getSchemas.mockReturnValue([
      {
        name: 'Bash',
        description: 'Execute shell command',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
        category: 'shell',
        permissionLevel: 'execute',
      },
    ]);
    mocks.has.mockImplementation((name: string) => name === 'Bash');
    mocks.handlerExecute.mockReset();
    mocks.handlerExecute.mockImplementation(async () => ({ ok: true, output: 'ok' }));
    mocks.resolve.mockResolvedValue({
      execute: mocks.handlerExecute,
    });
  });

  it('System Events GUI 输入命令：审批请求照常发出（披露不改审批规则）', async () => {
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({
      workingDirectory: '/tmp/gui-takeover-disclosure-test',
      requestPermission,
    });
    executor.setAuditEnabled(false);

    const result = await executor.execute('Bash', { command: GUI_KEYSTROKE_COMMAND }, {
      sessionId: 'session-gui-disclosure',
      currentToolCallId: 'call-gui-1',
    });

    // 审批被请求且在放行后执行成功。
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true });
  });

  it('对照：安全命令（git status）不触发审批——既有自动放行行为不受披露改动影响', async () => {
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({
      workingDirectory: '/tmp/gui-takeover-disclosure-test',
      requestPermission,
    });
    executor.setAuditEnabled(false);

    const result = await executor.execute('Bash', { command: 'git status' }, {
      sessionId: 'session-gui-disclosure',
      currentToolCallId: 'call-safe-1',
    });

    expect(requestPermission).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
  });
});
