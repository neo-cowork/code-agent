import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getApplicationRunRegistry, resetApplicationRunRegistryForTests } from '../../../../src/host/app/applicationRunRegistry';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { prepareNativeToolCheckpoint } from '../../../../src/host/tools/nativeToolCheckpoint';
import { createAgentDurableRouteRunLifecycle } from '../../../../src/web/routes/agentDurableRouteLifecycle';

const readTool = { name: 'Read', description: 'Read a file', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: {} }, requiresPermission: false, permissionLevel: 'read' } as never;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

// A background helper's Read runs under the parent's run id and can still be in flight when the parent's
// reply turn completes. The finished reply must stay `completed` — no "运行失败" card for the helper's tool.
describe('parent turn completing while a helper tool call is in flight', () => {
  let db: Database.Database;
  let repository: DurableRunRepository;
  let registry: ReturnType<typeof getApplicationRunRegistry>;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repository = new DurableRunRepository(db);
    repository.migrate();
    registry = getApplicationRunRegistry();
    registry.configureDurableKernel(new DurableRunKernel({ stores: repository, ownerId: 'host', processInstanceId: 'detached-tool-test', leaseDurationMs: 60_000 }));
  });
  afterEach(() => {
    resetApplicationRunRegistryForTests();
    db.close();
  });

  async function startRoute() {
    const lifecycle = createAgentDurableRouteRunLifecycle({ runRegistry: registry, sessionId: 'session-detached', workspace: '/tmp/project', durableActivation: true, logger: logger as never });
    const { runHandle } = await lifecycle.start();
    return { lifecycle, runId: runHandle.context.runId };
  }

  it('route markSuccess completes the run and the late tool completion is skipped', async () => {
    const { lifecycle, runId } = await startRoute();
    const checkpoint = await prepareNativeToolCheckpoint({ runId, sourceMessageId: 'message-1', toolName: 'Read', toolDefinition: readTool, toolCallId: 'helper-read', executionId: 'helper-read-exec', startedAt: Date.now() });

    await expect(lifecycle.markSuccess({ finalStatus: 'completed' })).resolves.toBe('completed');

    const stored = (await repository.get(runId))!;
    expect(stored.status).toBe('completed');
    expect(stored.pendingOperations?.find((operation) => operation.operationId === 'tool:helper-read')?.status).toBe('abandoned');
    await expect(checkpoint.complete(true)).resolves.toBeUndefined();
  });

  it('a tool call that already finished is left as succeeded', async () => {
    const { lifecycle, runId } = await startRoute();
    const checkpoint = await prepareNativeToolCheckpoint({ runId, sourceMessageId: 'message-1', toolName: 'Read', toolDefinition: readTool, toolCallId: 'own-read', executionId: 'own-read-exec', startedAt: Date.now() });
    await checkpoint.complete(true);

    await expect(lifecycle.markSuccess({ finalStatus: 'completed' })).resolves.toBe('completed');
    expect((await repository.get(runId))!.pendingOperations?.find((operation) => operation.operationId === 'tool:own-read')?.status).toBe('succeeded');
  });
});
