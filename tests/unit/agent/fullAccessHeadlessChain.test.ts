// 「完全访问 + 走开」链路集成测试（N-FIX-SOL-COWORK-DOGFOOD-HEADLESS-FU4-FU1）：
// (a) 生产 handler setSessionPermissionMode 把会话档位落到 session-permission-modes.json；
// (b) 该会话里真实 ToolExecutor → spawn_agent → SubagentExecutor 起子代理，`childContext applied` 的 effectiveMode 继承 bypassPermissions；
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
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { withTaskOutputDirectory } from '../../../src/host/permissions/taskOutputDirectory';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';

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
    getProtocolRegistry();
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
    const outsideFile = nodePath.join(fs.realpathSync(outsideDir), 'minutes.md');
    const ungrantedFile = nodePath.join(fs.realpathSync(tmpDataDir), 'not-authorized.md');
    const events: Array<{ type: string; data: unknown }> = [];
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: (request) => island.requestPermission(request),
    });
    executor.setAuditEnabled(false);
    const options = {
      sessionId: SESSION_ID, modelConfig: { provider: 'test', model: 'test-model' },
      abortSignal: new AbortController().signal,
      emitEvent: (type: string, data: unknown) => { events.push({ type, data }); },
    };
    await withTaskOutputDirectory({
      sessionId: SESSION_ID, internal: false, userText: `输出目录：${fs.realpathSync(outsideDir)}`,
    }, async () => {
      env.responses.push(
        toolUse({ name: 'Bash', arguments: { command: 'echo minutes-ready' } }, { name: 'Write', arguments: { file_path: outsideFile, content: '# minutes' } }),
        { type: 'text', content: 'done', usage: { inputTokens: 4, outputTokens: 5 } },
      );
      const result = await executor.execute('spawn_agent', {
        name: 'minutes-agent', task: 'write minutes', customPrompt: 'You write minutes.',
        customTools: ['Bash', 'Write'],
      }, options);
      expect(result.error).toBeUndefined();
      const applied = env.infos.find((entry) => entry.message.includes('childContext applied'));
      expect(applied?.meta).toMatchObject({ effectiveMode: 'bypassPermissions' });
      expect(result).toMatchObject({ success: true });
      expect(fs.readFileSync(outsideFile, 'utf8')).toBe('# minutes');
      expect(events.some((event) => event.type === 'tool_call_end'
        && (event.data as { success: boolean; output?: string }).success
        && (event.data as { output?: string }).output?.includes('minutes-ready'))).toBe(true);
      const copied = nodePath.join(fs.realpathSync(outsideDir), 'minutes-copy.md');
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const copy = await executor.execute('Bash', { command: `cp ${quote(outsideFile)} ${quote(copied)}` }, options);
      expect(copy).toMatchObject({ success: true });
      expect(fs.readFileSync(copied, 'utf8')).toBe('# minutes');
      expect(events.filter((event) => event.type === 'tool_call_start').map((event) => (event.data as { name: string }).name)).toEqual(expect.arrayContaining(['Bash', 'Write']));
      expect(env.infos.filter((entry) => entry.message === 'Approval request raised')).toEqual([]);
      expect(cards).toHaveLength(0);
      // A different directory is not covered, even during the authorized task.
      env.responses.push(
        toolUse({ name: 'Write', arguments: { file_path: ungrantedFile, content: '# outside grant' } }),
        { type: 'text', content: 'done', usage: { inputTokens: 4, outputTokens: 5 } },
      );
      await executor.execute('spawn_agent', {
        name: 'outside-grant', task: 'write minutes', customPrompt: 'You write minutes.', customTools: ['Write'],
      }, options);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ tool: 'Write', forceConfirm: true, reasonCode: 'file_write_outside_workspace' });
      expect(fs.existsSync(ungrantedFile)).toBe(false);
      cards.length = 0;

    });
    // The very same tool / session / target after task termination needs confirmation.
    // Spawn again to exercise the pipeline as well as the real executor, not just a helper.
    env.responses.push(
      toolUse({ name: 'Write', arguments: { file_path: outsideFile, content: '# expired' } }),
      { type: 'text', content: 'done', usage: { inputTokens: 4, outputTokens: 5 } },
    );
    await executor.execute('spawn_agent', {
      name: 'expired-task', task: 'write minutes', customPrompt: 'You write minutes.',
      customTools: ['Write'],
    }, options);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ tool: 'Write', forceConfirm: true, reasonCode: 'file_write_outside_workspace' });
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('# minutes');
    expect(env.infos.filter((entry) => entry.message === 'Approval request raised'
      && (entry.meta as { forceConfirm?: boolean }).forceConfirm === false)).toEqual([]);
  });
});
