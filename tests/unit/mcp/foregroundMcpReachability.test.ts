// ============================================================================
// 文字前台用户 MCP 可达性单测（N-EXTHISTORY-IMPORT-K1B-MCP-REDESIGN）
// 走公开入口：resolveForegroundMcpToolScope + withSessionCommandCenterBrain +
// isToolDeniedByRunPolicy + filterToolsByRunPolicy
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '../../../src/shared/contract';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

const home = vi.hoisted(() => ({ dir: '' }));
const fakeClient = vi.hoisted(() => ({
  states: new Map<string, { status: string }>(),
  started: [] as string[],
  signals: [] as Array<AbortSignal | undefined>,
  release: [] as Array<() => void>,
  addServer: (config: { name: string }) => { fakeClient.states.set(config.name, { status: 'lazy' }); },
  getServerState: (name: string) => fakeClient.states.get(name),
  ensureConnected: (name: string, signal?: AbortSignal) => {
    fakeClient.started.push(name);
    fakeClient.signals.push(signal);
    return new Promise<boolean>((resolve) => { fakeClient.release.push(() => resolve(true)); });
  },
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({ getMCPClient: () => fakeClient }));

vi.mock('../../../src/host/config/configPaths', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/config/configPaths')>('../../../src/host/config/configPaths');
  return {
    ...actual,
    getMcpScopedConfigPaths: () => ({ user: path.join(home.dir, 'mcp.json'), project: null, local: null }),
  };
});

import { resolveForegroundMcpToolScope } from '../../../src/host/mcp/foregroundMcpServers';
import { getDefaultMCPServers } from '../../../src/host/mcp/mcpDefaultServers';
import { withSessionCommandCenterBrain } from '../../../src/host/app/sessionCommandCenterBrain';
import { isToolDeniedByRunPolicy } from '../../../src/host/tools/runToolPolicy';
import { filterToolsByRunPolicy } from '../../../src/host/agent/runtime/toolRunPolicy';

function toolDef(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
    requiresPermission: true,
    permissionLevel: 'execute',
  };
}

describe('foregroundMcpReachability（普通会话文字前台经 toolScope.allowedMcpServerIds 可达）', () => {
  beforeEach(async () => {
    home.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-mcp-reach-'));
  });

  afterEach(async () => {
    await fs.rm(home.dir, { recursive: true, force: true });
  });

  it('从用户 mcp.json 配置构建 toolScope.allowedMcpServerIds（不依赖实时连接状态），使普通会话前台保留已启用导入 MCP 工具并继续收窄内置服务器', async () => {
    const prompt = '用我从 Cursor 导入的 external-import-nonce 帮我取一个随机串';
    await fs.writeFile(
      path.join(home.dir, 'mcp.json'),
      JSON.stringify({
        servers: [
          { name: 'external-import-nonce', type: 'stdio', command: 'node', args: ['nonce.mjs'], enabled: true },
          { name: 'imported-disabled', type: 'stdio', command: 'node', args: ['off.mjs'], enabled: false },
          { name: 'deepwiki', type: 'stdio', command: 'node', enabled: true },
          { name: 'cua-driver', type: 'stdio', command: 'node', enabled: true },
        ],
      }),
      'utf-8',
    );

    const toolScope = await resolveForegroundMcpToolScope(undefined, { preconnect: false });
    expect(toolScope).toEqual({ allowedMcpServerIds: ['external-import-nonce'] });

    const brainOptions = withSessionCommandCenterBrain({ toolScope }, prompt);
    const policy = {
      allowedToolNames: brainOptions.allowedToolNames,
      deniedToolNames: brainOptions.deniedToolNames as readonly string[] | undefined,
      toolScope: brainOptions.toolScope,
    };

    expect(isToolDeniedByRunPolicy(policy, 'mcp__external-import-nonce__get_random_nonce')).toBe(false);
    expect(isToolDeniedByRunPolicy(policy, 'mcp__imported-disabled__ping')).toBe(true);
    expect(isToolDeniedByRunPolicy(policy, 'mcp__deepwiki__ask_question')).toBe(true);
    expect(isToolDeniedByRunPolicy(policy, 'mcp__cua-driver__screenshot')).toBe(true);
    expect(isToolDeniedByRunPolicy(policy, 'Bash')).toBe(true);

    const ctx = {
      messages: [{ role: 'user', content: prompt }],
      turn: { runUserPrompt: prompt },
      allowedToolNames: brainOptions.allowedToolNames,
      deniedToolNames: brainOptions.deniedToolNames,
      toolScope: brainOptions.toolScope,
    } as unknown as RuntimeContext;

    const candidateTools: ToolDefinition[] = [
      toolDef('Read'),
      toolDef('delegate_task'),
      toolDef('Bash'),
      toolDef('mcp__external-import-nonce__get_random_nonce'),
      toolDef('mcp__imported-disabled__ping'),
      toolDef('mcp__deepwiki__ask_question'),
      toolDef('mcp__cua-driver__screenshot'),
    ];
    const filtered = filterToolsByRunPolicy(candidateTools, ctx).map((t) => t.name);
    expect(filtered).toContain('mcp__external-import-nonce__get_random_nonce');
    expect(filtered).toContain('Read');
    expect(filtered).toContain('delegate_task');
    expect(filtered).not.toContain('mcp__imported-disabled__ping');
    expect(filtered).not.toContain('mcp__deepwiki__ask_question');
    expect(filtered).not.toContain('mcp__cua-driver__screenshot');
    expect(filtered).not.toContain('Bash');
  });

  it('内置默认名单覆盖 getDefaultMCPServers 全部服务器 + cua-driver/argus/in-process；无启用用户服务器时返回原 toolScope', async () => {
    const servers = [
      ...getDefaultMCPServers().map((server) => ({ name: server.name, type: 'stdio', command: 'node', enabled: true })),
      { name: 'cua-driver', type: 'stdio', command: 'node', enabled: true },
      { name: 'argus', type: 'stdio', command: 'node', enabled: true },
      { name: 'memory-kv', type: 'in-process', enabled: true },
      { name: 'code-index', type: 'in-process', enabled: true },
    ];
    await fs.writeFile(path.join(home.dir, 'mcp.json'), JSON.stringify({ servers }), 'utf-8');
    expect(await resolveForegroundMcpToolScope(undefined, { preconnect: false })).toBeUndefined();

    // 显式手选了 MCP 服务器时尊重显式选择，不被全量已启用列表覆盖
    await fs.writeFile(
      path.join(home.dir, 'mcp.json'),
      JSON.stringify({
        servers: [
          { name: 'user-a', type: 'stdio', command: 'node', enabled: true },
          { name: 'user-b', type: 'stdio', command: 'node', enabled: true },
        ],
      }),
      'utf-8',
    );
    expect(
      await resolveForegroundMcpToolScope({ allowedMcpServerIds: ['user-a'] }, { preconnect: false }),
    ).toEqual({ allowedMcpServerIds: ['user-a'] });
  });

  it('预连接并行发起、带前台短预算信号，且不在每轮重试 error 状态的服务器', async () => {
    fakeClient.states.clear();
    fakeClient.started.length = 0;
    fakeClient.signals.length = 0;
    fakeClient.release.length = 0;
    await fs.writeFile(
      path.join(home.dir, 'mcp.json'),
      JSON.stringify({
        servers: [
          { name: 'slow-a', type: 'stdio', command: 'node', enabled: true },
          { name: 'slow-b', type: 'stdio', command: 'node', enabled: true },
          { name: 'broken', type: 'stdio', command: 'node', enabled: true },
        ],
      }),
      'utf-8',
    );
    fakeClient.states.set('broken', { status: 'error' });

    const pending = resolveForegroundMcpToolScope(undefined);
    await vi.waitFor(() => expect(fakeClient.started).toHaveLength(2));
    // 两个 server 都已发起连接，而第一个还没完成 → 并行而非串行
    expect(fakeClient.started.sort()).toEqual(['slow-a', 'slow-b']);
    expect(fakeClient.signals.every((signal) => signal !== undefined)).toBe(true);
    fakeClient.release.forEach((release) => release());
    const scope = await pending;
    expect(scope?.allowedMcpServerIds).toEqual(['slow-a', 'slow-b', 'broken']);
    expect(fakeClient.started).not.toContain('broken');
  });
});
