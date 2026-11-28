import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import {
  createAgentDurableRouteRunLifecycle,
  resolveNativeRunWorkspaceScope,
} from '../../../src/web/routes/agentDurableRouteLifecycle';
import { DurableStaleHandleError } from '../../../src/host/runtime/durableLeaseGuards';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { createRunContext, createRunHandle } from '../../../src/host/runtime/runContext';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import type { WorkspaceScope } from '../../../src/shared/contract/project';
import type { CreateRunContextInput, RunHandle } from '../../../src/host/runtime/runContext';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function projectScope(primaryRoot: string, projectId = 'project-native'): WorkspaceScope {
  return createWorkspaceScope(projectId, [{
    sourceId: 'source-primary',
    path: primaryRoot,
    role: 'primary',
    access: 'read_write',
  }]);
}

function fakeRegistry(startDurable: (input: CreateRunContextInput) => Promise<RunHandle> | RunHandle) {
  const stub = vi.fn(startDurable);
  return {
    registry: { startDurable: stub, start: vi.fn(), supersedeParkedSessionRoots: vi.fn(async () => undefined) } as unknown as RunRegistry,
    startDurable: stub,
  };
}

describe('resolveNativeRunWorkspaceScope', () => {
  it('binds a real Project scope whose workspace stays inside the boundary', () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-bind-')));
    try {
      const scope = projectScope(workspace);
      expect(resolveNativeRunWorkspaceScope({ sessionScope: scope, workspace })).toBe(scope);
      expect(resolveNativeRunWorkspaceScope({
        sessionScope: scope,
        workspace: path.join(workspace, 'nested'),
      })).toBe(scope);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps the legacy fallback for isolated Fork scopes', () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-isolated-')));
    try {
      const isolated = {
        ...projectScope(workspace),
        version: `isolated-v1:intent:evidence`,
      };
      expect(resolveNativeRunWorkspaceScope({ sessionScope: isolated, workspace })).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps the legacy fallback when the session workspace left the Project boundary', () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-outside-')));
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-elsewhere-')));
    try {
      const scope = projectScope(workspace);
      expect(resolveNativeRunWorkspaceScope({ sessionScope: scope, workspace: elsewhere }))
        .toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('returns undefined when the session has no scope at all', () => {
    expect(resolveNativeRunWorkspaceScope({ sessionScope: undefined, workspace: '/repo' }))
      .toBeUndefined();
  });
});

describe('AgentDurableRouteRunLifecycle durable start', () => {
  it('passes the Project scope through so the run carries the real projectId', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-run-')));
    try {
      const scope = projectScope(workspace, 'project-from-session');
      const { registry, startDurable } = fakeRegistry((input) => (
        createRunHandle(createRunContext(input))
      ));

      const lifecycle = createAgentDurableRouteRunLifecycle({
        runRegistry: registry,
        sessionId: 'session-project',
        workspace,
        workspaceScope: scope,
        durableActivation: true,
        logger,
      });
      const { runHandle } = await lifecycle.start();

      expect(startDurable).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-project',
        workspace,
        workspaceScope: scope,
        cwd: workspace,
      }));
      expect(runHandle.context.workspaceScope?.projectId).toBe('project-from-session');
      expect(runHandle.context.cwd).toBe(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('widens a sub-folder session to the Project root while keeping cwd on the session folder', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-nested-')));
    const nested = path.join(workspace, 'pkg');
    mkdirSync(nested);
    try {
      const scope = projectScope(workspace, 'project-nested');
      const { registry } = fakeRegistry((input) => createRunHandle(createRunContext(input)));
      const { runHandle } = await createAgentDurableRouteRunLifecycle({
        runRegistry: registry,
        sessionId: 'session-nested',
        workspace: nested,
        workspaceScope: resolveNativeRunWorkspaceScope({ sessionScope: scope, workspace: nested }),
        durableActivation: true,
        logger,
      }).start();

      // 与 orchestrator 路径一致：run 的 workspace（工具缓存 / 账本 / policy 根）取 Project 根，
      // 相对路径与进程目录仍落在会话文件夹。
      expect(runHandle.context.workspace).toBe(workspace);
      expect(runHandle.context.cwd).toBe(nested);
      expect(runHandle.context.workspaceScope?.projectId).toBe('project-nested');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('starts without a scope (legacy fallback) when none is bindable', async () => {
    const { registry, startDurable } = fakeRegistry((input) => (
      createRunHandle(createRunContext(input))
    ));

    const lifecycle = createAgentDurableRouteRunLifecycle({
      runRegistry: registry,
      sessionId: 'session-legacy',
      workspace: realpathSync(tmpdir()),
      durableActivation: true,
      logger,
    });
    await lifecycle.start();

    const input = startDurable.mock.calls[0][0];
    expect(input.workspaceScope).toBeUndefined();
    // cwd 钉在会话工作目录上，不带 scope 时行为与旧路径一致。
    expect(input.cwd).toBe(input.workspace);
  });
});

describe('AgentDurableRouteRunLifecycle superseded handle', () => {
  it('keeps a finished turn completed when a recovered handle took over the same run', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-route-superseded-')));
    const db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    const registry = new RunRegistry();
    registry.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'web-worker',
      leaseDurationMs: 60_000,
    }));
    const routeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    try {
      const lifecycle = createAgentDurableRouteRunLifecycle({
        runRegistry: registry,
        sessionId: 'session-superseded',
        workspace,
        durableActivation: true,
        logger: routeLogger,
      });
      const { runHandle } = await lifecycle.start();
      const runId = runHandle.context.runId;

      // The path the nightly took: recovery unregistered the route's handle and a resumed loop
      // adopted the same run under a new handle while the original loop was still finishing.
      expect(registry.unregister(runId, runHandle)).toBe(true);
      const adopted = registry.adoptRecoveredRun({ runId, sessionId: 'session-superseded', workspace, cwd: workspace });
      expect(adopted).not.toBe(runHandle);

      await expect(lifecycle.markSuccess({ finalStatus: 'completed' })).resolves.toBe('completed');
      expect(routeLogger.error).not.toHaveBeenCalled();
      expect(routeLogger.warn).toHaveBeenCalledTimes(1);
      expect(routeLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('superseded'),
        expect.objectContaining({
          runId,
          sessionId: 'session-superseded',
          staleHandle: { attempt: 1, ownerEpoch: 1 },
          currentHandle: { attempt: 1, ownerEpoch: 1 },
          durableOwner: { attempt: 1, epoch: 1, processInstanceId: 'web-worker' },
        }),
      );
      // Releasing the superseded route must not unregister or release the adopted handle's run.
      await lifecycle.release();
      expect(registry.get(runId)).toBe(adopted);
      expect(await repository.get(runId)).toMatchObject({ status: 'running', attempt: 1 });

      const terminal = {
        now: Date.now(),
        status: 'completed' as const,
        reason: 'completed',
        event: { type: 'run_completed', payload: { sessionId: 'session-superseded' }, recordedAt: Date.now() },
      };
      const stale = registry.terminalDurable(runId, terminal, runHandle);
      await expect(stale).rejects.toBeInstanceOf(DurableStaleHandleError);
      await expect(stale).rejects.toThrow(`Durable Run terminal fenced by stale handle: ${runId}`);
      await expect(registry.parkDurable(runId, { reason: 'user_stop' }, runHandle)).rejects.toBeInstanceOf(DurableStaleHandleError);
      await expect(registry.terminalDurable(runId, terminal, adopted)).resolves.toMatchObject({ runId, status: 'completed' });
    } finally {
      registry.clear();
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('logs a superseded failure report as a warning and still surfaces other terminal errors', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-route-superseded-failure-')));
    const db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    const registry = new RunRegistry();
    registry.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'web-worker',
      leaseDurationMs: 60_000,
    }));
    const routeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    try {
      const superseded = createAgentDurableRouteRunLifecycle({
        runRegistry: registry, sessionId: 'session-superseded-failure', workspace, durableActivation: true, logger: routeLogger,
      });
      const { runHandle } = await superseded.start();
      const runId = runHandle.context.runId;
      registry.unregister(runId, runHandle);
      const adopted = registry.adoptRecoveredRun({ runId, sessionId: 'session-superseded-failure', workspace, cwd: workspace });
      await superseded.markFailure({ disconnected: false, message: 'late failure' });
      expect(routeLogger.error).not.toHaveBeenCalled();
      expect(routeLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('superseded'),
        expect.objectContaining({ runId, staleHandle: { attempt: 1, ownerEpoch: 1 }, currentHandle: { attempt: 1, ownerEpoch: 1 } }),
      );
      expect(await repository.get(runId)).toMatchObject({ status: 'running' });

      // Any other terminal failure keeps today's behaviour: markSuccess rejects, markFailure logs error.
      await registry.terminalDurable(runId, {
        now: Date.now(), status: 'completed', reason: 'completed',
        event: { type: 'run_completed', payload: {}, recordedAt: Date.now() },
      }, adopted);
      const lostOwner = createAgentDurableRouteRunLifecycle({
        runRegistry: registry, sessionId: 'session-lost-owner', workspace, durableActivation: true, logger: routeLogger,
      });
      const started = await lostOwner.start();
      vi.spyOn(repository, 'commitTerminal').mockRejectedValueOnce(new Error('disk I/O error'));
      await expect(lostOwner.markSuccess({ finalStatus: 'completed' })).rejects.toThrow('disk I/O error');
      vi.spyOn(repository, 'commitTerminal').mockRejectedValueOnce(new Error('disk I/O error'));
      await lostOwner.markFailure({ disconnected: false, message: 'boom' });
      expect(routeLogger.error).toHaveBeenCalledWith('Durable Run terminal commit failed:', expect.objectContaining({ message: 'disk I/O error' }));
      expect(registry.get(started.runHandle.context.runId)).toBe(started.runHandle);
    } finally {
      vi.restoreAllMocks();
      registry.clear();
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
