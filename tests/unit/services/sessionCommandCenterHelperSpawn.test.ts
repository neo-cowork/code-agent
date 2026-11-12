import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentExecutionRequest, SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import type { CanUseToolFn, ToolContext } from '../../../src/host/protocol/tools';
const executor = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/agent/subagentExecutor', () => ({ getSubagentExecutor: () => ({ execute: executor }) }));
vi.mock('../../../src/host/context/subagentContextStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/context/subagentContextStore')>();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const store = new actual.SubagentContextStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-status-')), 'contexts.json'));
  return { ...actual, getSubagentContextStore: () => store };
});
import { spawnAgentModule } from '../../../src/host/tools/modules/multiagent/spawnAgent';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { withPersistedSubagentLifecycle } from '../../../src/host/agent/subagentContextLifecycle';
import { executeTaskStatus } from '../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import { getAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
const allow: CanUseToolFn = async () => ({ allow: true });
afterEach(() => { resetSpawnGuard(); executor.mockReset(); });
describe('actual spawn branches through task_status', () => {
  it.each([true, false])('run_in_background=%s preserves the spawn name and one shared row', async (wrapped) => {
    let resolve!: (result: SubagentResult) => void;
    const gate = new Promise<SubagentResult>((done) => { resolve = done; });
    executor.mockImplementation((request: SubagentExecutionRequest) => withPersistedSubagentLifecycle(request, () => gate));
    const sessionId = `actual-helper-spawn-${wrapped}`;
    const ctx: ToolContext = {
      sessionId, workspace: '/tmp', workingDir: '/tmp', abortSignal: new AbortController().signal,
      emit: () => undefined,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      modelConfig: { provider: 'test', model: 'test-model' }, resolver: { getDefinition: () => undefined },
    };
    const handler = await spawnAgentModule.createHandler();
    const receipt = await handler.execute({ role: 'explore', name: '总结B', task: 'Read folder-b notes', isolation: 'none',
      ...(wrapped ? { run_in_background: true } : { waitForCompletion: false }) }, ctx, allow);
    expect(receipt.ok).toBe(true);
    await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
    const args: SubagentExecutionRequest = executor.mock.calls[0][0];
    expect(args.config.name).toBe('总结B');
    const active = await executeTaskStatus({}, ctx, allow);
    expect(active.ok && active.output).toContain('总结B [running]');
    expect(getSpawnGuard().list()).toHaveLength(1);
    expect(getBackgroundSubagentRegistry().listBySession(sessionId)).toHaveLength(wrapped ? 1 : 0);
    resolve({ success: true, output: 'Folder B summarized', toolsUsed: ['Read'], iterations: 1 });
    await vi.waitFor(() => expect(getSpawnGuard().list()[0].status).toBe('completed'));
    if (wrapped) await vi.waitFor(() => expect(getBackgroundSubagentRegistry().listBySession(sessionId)[0].status).toBe('completed'));
    const completed = await executeTaskStatus({}, ctx, allow);
    expect(completed.ok && completed.output).toContain('总结B [completed]');
    expect(completed.ok && completed.output.match(/\[completed\]/g)).toHaveLength(1);
    expect(getAgentTreeSnapshot({ sessionId }).nodes).toHaveLength(1);
  });
});
