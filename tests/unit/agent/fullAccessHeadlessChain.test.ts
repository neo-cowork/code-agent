// 「完全访问 + 走开」链路集成测试（N-FIX-SOL-COWORK-DOGFOOD-HEADLESS-FU4-FU1）：
// (a) 生产 handler setSessionPermissionMode 把会话档位落到 session-permission-modes.json；
// (b) 该会话里真实 SubagentExecutor 起子代理，`childContext applied` 的 effectiveMode 继承 bypassPermissions；
// (c) 子代理的 Bash / 工作区外 Write 经真实 ToolExecutor → 真实 OrchestratorPermissionIsland，
//     不产生 forceConfirm=false 的 `Approval request raised`（普通审批卡）。
// 只替身外部边界：模型推理、auth 账号、日志采集；档位管理器 / 子代理执行器 / childContext / ToolExecutor / 审批岛全真实。
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as nodePath from 'path';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const { tmpDataDir, workspace, outsideDir } = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePathMod = await import('node:path');
  const mk = (prefix: string) => nodeFs.mkdtempSync(nodePathMod.join(nodeOs.tmpdir(), prefix));
  return { tmpDataDir: mk('full-access-chain-'), workspace: mk('full-access-ws-'), outsideDir: mk('full-access-out-') };
});
process.env.CODE_AGENT_DATA_DIR = tmpDataDir;
process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
afterAll(() => {
  delete process.env.CODE_AGENT_DATA_DIR;
  delete process.env.CODE_AGENT_MODEL_ENGINE;
  for (const dir of [tmpDataDir, workspace, outsideDir]) fs.rmSync(dir, { recursive: true, force: true });
});

const env = vi.hoisted(() => ({
  infos: [] as Array<{ message: string; meta: unknown }>,
  responses: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const log = {
    info: (message: string, meta?: unknown) => { env.infos.push({ message, meta }); },
    debug: vi.fn(), error: vi.fn(), warn: vi.fn(),
  };
  return { createLogger: vi.fn(() => log), logger: log, LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } };
});
vi.mock('../../../src/host/platform', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => tmpDataDir },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: vi.fn(),
}));
vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ recordDetachedTurn: vi.fn() }),
}));
vi.mock('../../../src/host/services/auth', () => ({
  getAuthService: () => ({
    getCurrentUser: () => ({ id: 'admin-1', email: 'admin@example.test', isAdmin: true }),
    hasVerifiedSession: () => true,
    getSessionTrustState: () => 'verified',
    revalidateSession: async () => 'verified',
  }),
}));
vi.mock('../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    inference = vi.fn(async () => {
      const next = env.responses.shift();
      if (!next) throw new Error('Missing mocked inference response');
      return next;
    });
  },
  PROVIDER_REGISTRY: { test: { models: [{ id: 'test-model', supportsTool: true }] } },
}));
vi.mock('../../../src/host/model/adapters/aiSdkAdapter', () => ({
  aiSdkSupportsProvider: () => false,
  inferenceViaAiSdk: vi.fn(),
}));

import { registerAgentHandlers } from '../../../src/host/ipc/agent.ipc';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getToolResolver } from '../../../src/host/tools/dispatch/toolResolver';

type DomainHandler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
const SESSION_ID = 'session-full-access-walk-away';

function toolUse(...calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  return {
    type: 'tool_use',
    toolCalls: calls.map((call, index) => ({ id: `call-${index}-${call.name}`, ...call })),
    usage: { inputTokens: 4, outputTokens: 5 },
  };
}

describe('full access, walk away: session mode → sub-agent inheritance → zero ordinary approvals', () => {
  let handler: DomainHandler;

  beforeEach(() => {
    resetPermissionModeManager();
    env.infos.length = 0;
    env.responses.length = 0;
    const handlers = new Map<string, unknown>();
    registerAgentHandlers({ handle: (c: string, fn: unknown) => handlers.set(c, fn), on: vi.fn(), removeHandler: vi.fn() } as never, () => null);
    handler = handlers.get(IPC_DOMAINS.AGENT) as DomainHandler;
  });

  it('(a) the production handler persists bypassPermissions for the session', async () => {
    const response = await handler(null, {
      action: 'setSessionPermissionMode',
      payload: { sessionId: SESSION_ID, mode: 'bypassPermissions', approved: true },
    } as IPCRequest);
    expect(response.success).toBe(true);
    expect(response.data).toEqual({ changed: true, mode: 'bypassPermissions' });
    const persisted = JSON.parse(fs.readFileSync(nodePath.join(tmpDataDir, 'session-permission-modes.json'), 'utf8'));
    expect(persisted[SESSION_ID]).toBe('bypassPermissions');
  });

  it('(b)(c) a spawned child inherits bypassPermissions and Bash / outside-workspace Write raise no ordinary approval', async () => {
    await handler(null, {
      action: 'setSessionPermissionMode',
      payload: { sessionId: SESSION_ID, mode: 'bypassPermissions', approved: true },
    } as IPCRequest);

    // 强制确认（工作区外写边界）会真的出审批卡：这里像无人应答的无头会话一样把卡拒掉，并收集卡的形态
    const cards: Array<Record<string, unknown>> = [];
    const island: OrchestratorPermissionIsland = new OrchestratorPermissionIsland({
      getSettings: () => ({ permissions: {} }) as never,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => true,
      onEvent: (event) => {
        if (event.type !== 'permission_request') return;
        const card = event.data as { id: string };
        cards.push(card as unknown as Record<string, unknown>);
        island.handlePermissionResponse(card.id, 'deny');
      },
    });
    const outsideFile = nodePath.join(outsideDir, 'minutes.md');
    env.responses.push(
      toolUse({ name: 'Bash', arguments: { command: 'echo minutes-ready' } }, { name: 'Write', arguments: { file_path: outsideFile, content: '# minutes' } }),
      { type: 'text', content: 'done', usage: { inputTokens: 4, outputTokens: 5 } },
    );

    const result = await new SubagentExecutor().execute({
      prompt: 'write minutes',
      config: { name: 'minutes-agent', systemPrompt: 'You write minutes.', availableTools: ['Bash', 'Write'] },
      context: {
        sessionId: SESSION_ID,
        cwd: workspace,
        modelConfig: { provider: 'test', model: 'test-model' },
        resolver: getToolResolver(),
        permission: { request: (request: never) => island.requestPermission(request) },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
      } as never,
    });

    const applied = env.infos.find((entry) => entry.message.includes('childContext applied'));
    expect(applied?.meta).toMatchObject({ effectiveMode: 'bypassPermissions' });
    expect(result.success).toBe(true);
    const raised = env.infos.filter((entry) => entry.message === 'Approval request raised');
    const ordinary = raised.filter((entry) => (entry.meta as { forceConfirm?: boolean }).forceConfirm === false);
    expect(ordinary).toEqual([]);
    // Bash 在 bypass 档免审批；工作区外 Write 是有名字的信任边界卡（强制确认），不是普通卡
    expect(raised.filter((entry) => (entry.meta as { tool?: string }).tool === 'Bash')).toEqual([]);
    expect(raised.map((entry) => entry.meta)).toEqual([
      expect.objectContaining({ tool: 'Write', forceConfirm: true, reasonCode: 'file_write_outside_workspace' }),
    ]);
    expect(cards).toHaveLength(1);
    expect(fs.existsSync(outsideFile)).toBe(false);
  });
});
