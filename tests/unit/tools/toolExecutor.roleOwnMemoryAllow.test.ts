// N-ROLE-WAKE-OWN-MEMORY-NO-APPROVAL：无人值守角色醒来写「自己的」角色层记忆 →
// 窄放行（auto-approve + 'role-own-memory-unattended' 账本行，不出审批卡）。
// 全部用例走生产入口 ToolExecutor.execute；agentRole 按 subagentExecutor.ts 往
// ExecuteOptions 灌的同一形状传递（agentRole: config.roleId），不手搓协议层替身。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
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
  getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }),
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
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { resetToolResolver } = await import('../../../src/host/tools/dispatch/toolResolver');
const { memoryWriteSchema } = await import('../../../src/host/tools/modules/lightMemory/memoryWrite.schema');
const { ROLE_OWN_MEMORY_UNATTENDED_REASON } = await import('../../../src/host/tools/roleOwnMemoryAllow');
const { getDecisionHistory } = await import('../../../src/host/security/decisionHistory');
const { getPermissionModeManager } = await import('../../../src/host/permissions/modes');

// 与生产 schema 同形的 MemoryWrite 声明（含 scope），其余工具用于「非本工具不放行」。
const schemas = [
  memoryWriteSchema,
  {
    name: 'Write',
    description: 'write file',
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
    category: 'fs',
    permissionLevel: 'write',
    pathAuthority: [{ kind: 'path', pathParameter: 'file_path' }],
  },
] as const;

const OWN_ROLE_WRITE = {
  action: 'write',
  scope: 'role',
  filename: 'preference-bullets.md',
  name: '汇报条数偏好',
  description: '用户只要 3 条要点',
  type: 'user',
  content: '用户汇报正文只要 3 条要点，多了看不完。',
};

describe('ToolExecutor unattended role own-memory write（N-ROLE-WAKE-OWN-MEMORY-NO-APPROVAL）', () => {
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
  let seq = 0;

  beforeEach(() => {
    process.env.CODE_AGENT_DATA_DIR = '/tmp/code-agent-role-own-memory';
    resetToolResolver();
    mocks.getSchemas.mockReturnValue(schemas);
    mocks.has.mockReturnValue(true);
    mocks.execute.mockReset().mockResolvedValue({ ok: true, output: 'saved' });
    mocks.resolve.mockResolvedValue({ execute: mocks.execute });
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  });

  function newExecutor(requestPermission = vi.fn(async () => true)) {
    const executor = new ToolExecutor({ workingDirectory: '/tmp', requestPermission });
    executor.setAuditEnabled(false);
    return { executor, requestPermission };
  }

  function unattendedSessionId(): string {
    seq += 1;
    const sessionId = `role-own-memory-wake-${seq}`;
    getPermissionModeManager().markUnattendedSession(sessionId);
    return sessionId;
  }

  it('无人值守醒来写自己的角色层记忆（scope role）→ 放行、零审批卡、账本行带专属 reason', async () => {
    const history = getDecisionHistory();
    history.clear();
    const sessionId = unattendedSessionId();
    const { executor, requestPermission } = newExecutor();

    // agentRole 的传递形状与 subagentExecutor.ts 相同：ExecuteOptions.agentRole = config.roleId
    const result = await executor.execute('MemoryWrite', { ...OWN_ROLE_WRITE }, {
      sessionId,
      agentRole: 'morning-notes',
    });

    expect(result).toMatchObject({ success: true, output: 'saved' });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(requestPermission).not.toHaveBeenCalled();
    const rows = history.getAll().filter((entry) => entry.sessionId === sessionId);
    expect(rows.some((entry) => (
      entry.outcome === 'auto-approve' && entry.reason === ROLE_OWN_MEMORY_UNATTENDED_REASON
    ))).toBe(true);
  });

  it('scope 缺省但带 agentRole（持久化角色默认层）→ 同样放行', async () => {
    const sessionId = unattendedSessionId();
    const { executor, requestPermission } = newExecutor();
    const { scope: _scope, ...withoutScope } = OWN_ROLE_WRITE;

    const result = await executor.execute('MemoryWrite', withoutScope, {
      sessionId,
      agentRole: 'morning-notes',
    });

    expect(result).toMatchObject({ success: true, output: 'saved' });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('复现分支：skill 边界不含 MemoryWrite（真跑里 <verify> 误命中 skill 的形状）→ 放行不被 boundaryViolation 拦', async () => {
    const sessionId = unattendedSessionId();
    const { executor, requestPermission } = newExecutor();

    const result = await executor.execute('MemoryWrite', { ...OWN_ROLE_WRITE }, {
      sessionId,
      agentRole: 'morning-notes',
      skillToolBoundary: { skillName: 'verify', allowedTools: ['Bash'], strict: false },
    });

    expect(result).toMatchObject({ success: true, output: 'saved' });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it.each([
    ['global scope', { ...OWN_ROLE_WRITE, scope: 'global' }],
    ['project scope', { ...OWN_ROLE_WRITE, scope: 'project' }],
    ['type directive', { ...OWN_ROLE_WRITE, type: 'directive' }],
    ['action delete', { ...OWN_ROLE_WRITE, action: 'delete' }],
  ])('%s → 照旧走审批（放行不生效）', async (_label, params) => {
    const sessionId = unattendedSessionId();
    const { executor, requestPermission } = newExecutor();

    const result = await executor.execute('MemoryWrite', params, {
      sessionId,
      agentRole: 'morning-notes',
    });

    // global scope 在无 UI 环境是「directive 门探针 + 主分支」两问，其余一问——
    // 只断言确实回到了人工审批链，次数不设精确值。
    expect(requestPermission.mock.calls.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ success: true });
    const rows = getDecisionHistory().getAll().filter((entry) => entry.sessionId === sessionId);
    expect(rows.some((entry) => entry.reason === ROLE_OWN_MEMORY_UNATTENDED_REASON)).toBe(false);
  });

  it('非 MemoryWrite 工具（Write）→ 照旧走审批', async () => {
    const sessionId = unattendedSessionId();
    const { executor, requestPermission } = newExecutor();

    const result = await executor.execute('Write', {
      file_path: path.join('/tmp', 'plain.txt'),
      content: 'x',
    }, { sessionId, agentRole: 'morning-notes' });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true });
  });

  it('交互会话（未标记无人值守）写 role scope → 路径与今天完全一致（照旧审批）', async () => {
    seq += 1;
    const sessionId = `role-own-memory-interactive-${seq}`; // 未 markUnattendedSession
    const { executor, requestPermission } = newExecutor();

    const result = await executor.execute('MemoryWrite', { ...OWN_ROLE_WRITE }, {
      sessionId,
      agentRole: 'morning-notes',
    });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true });
    const rows = getDecisionHistory().getAll().filter((entry) => entry.sessionId === sessionId);
    expect(rows.some((entry) => entry.reason === ROLE_OWN_MEMORY_UNATTENDED_REASON)).toBe(false);
  });

  it('没有 agentRole（scope role 解析不出运行角色）→ 不放行', async () => {
    const sessionId = unattendedSessionId();
    const { executor, requestPermission } = newExecutor();

    await executor.execute('MemoryWrite', { ...OWN_ROLE_WRITE }, { sessionId });

    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});
