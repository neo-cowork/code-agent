// 子代理团队跑完后，父 run 上的 agent-team:<调用> 操作必须落到终态。
// 回归：团队运行期间，子代理的原生工具检查点会整体覆盖父 run 的投影状态，
// 终态投影找不到操作 id，父 run 收尾时报「completed runs cannot contain unresolved operations」→ 用户看到「运行失败」。
// 走真实 RunRegistry + DurableRunKernel + 内存 sqlite 仓库，不替身任何一层。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getApplicationRunRegistry, resetApplicationRunRegistryForTests } from '../../../src/host/app/applicationRunRegistry';
import { AgentTeamDurableRuntime, stableAgentTeamRunId } from '../../../src/host/agent/agentTeamDurableAdapter';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import { prepareNativeToolCheckpoint } from '../../../src/host/tools/nativeToolCheckpoint';

const parentInput = { runId: 'run-parent-team', sessionId: 'session-team-1', workspace: '/tmp/project' };
const readTool = { name: 'Read', description: 'Read notes', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: {} }, requiresPermission: false, permissionLevel: 'read' } as never;

describe('agent team child_run terminal projection', () => {
  let db: Database.Database;
  let repository: DurableRunRepository;
  let kernel: DurableRunKernel;
  let registry: ReturnType<typeof getApplicationRunRegistry>;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repository = new DurableRunRepository(db);
    repository.migrate();
    kernel = new DurableRunKernel({ stores: repository, ownerId: 'host', processInstanceId: 'team-test', leaseDurationMs: 60_000 });
    registry = getApplicationRunRegistry();
    registry.configureDurableKernel(kernel);
  });
  afterEach(() => {
    resetApplicationRunRegistryForTests();
    db.close();
  });

  it('a sub-agent tool checkpoint during the team does not strand the parent child_run operation', async () => {
    await registry.startDurable(parentInput);
    const task = { id: 'minutes', role: 'coder', task: 'Write meeting minutes', tools: ['Read'] };
    const teamRunId = stableAgentTeamRunId(parentInput.runId, 'spawn-call');
    const controller = await new AgentTeamDurableRuntime(kernel, registry).start({
      parentRunId: parentInput.runId,
      logicalOperationId: 'spawn-call',
      scope: { runId: teamRunId, sessionId: parentInput.sessionId, treeId: teamRunId },
      tasks: [task],
      sideEffect: false,
    });
    expect((await repository.get(parentInput.runId))?.pendingOperations?.find((op) => op.operationId === 'agent-team:spawn-call')?.status).toBe('prepared');

    // 子代理在团队运行期间执行工具：原生工具检查点覆盖父 run 的投影状态
    const checkpoint = await prepareNativeToolCheckpoint({ runId: parentInput.runId, sourceMessageId: 'message-1', toolName: 'Read', toolDefinition: readTool, toolCallId: 'child-read', executionId: 'execution-child-read', startedAt: Date.now() });
    await checkpoint.complete(true);

    await controller.markNodeDispatched(task);
    await controller.markNodeTerminal(task, { taskId: task.id, role: task.role, success: true, output: 'done', toolsUsed: [], iterations: 1, startTime: 1, endTime: 2, duration: 1 });
    await controller.terminal('completed');

    const parent = (await repository.get(parentInput.runId))!;
    const operation = parent.pendingOperations?.find((op) => op.operationId === 'agent-team:spawn-call');
    expect(operation?.status).toBe('succeeded');
    expect(parent.pendingOperations?.filter((op) => !['succeeded', 'failed', 'abandoned'].includes(op.status))).toEqual([]);

    // 父 run 随后正常 completed，不再抛 unresolved operations
    await expect(registry.terminalDurable(parentInput.runId, { now: Date.now(), status: 'completed', event: { type: 'run_completed', payload: {}, recordedAt: Date.now() } })).resolves.toMatchObject({ status: 'completed' });
    expect((await repository.get(parentInput.runId))?.status).toBe('completed');
  });
});
