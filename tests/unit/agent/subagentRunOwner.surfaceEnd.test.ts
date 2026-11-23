import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  endRun: vi.fn(async () => undefined),
  runtime: null as { endRun: (input: unknown) => Promise<unknown> } | null,
  unregister: vi.fn(),
}));

vi.mock('../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime', () => ({
  getConfiguredSurfaceExecutionRuntime: () => mocks.runtime,
}));

vi.mock('../../../src/host/app/applicationRunRegistry', () => ({
  getConfiguredApplicationRunRegistry: () => ({
    startAuxiliary: () => ({
      context: { runId: 'aux-run-1' },
      attach: async () => undefined,
      cancel: async () => undefined,
    }),
    unregister: mocks.unregister,
  }),
}));

import { withSubagentRunOwner } from '../../../src/host/agent/subagentRunOwner';

function request() {
  return {
    prompt: 'open example.com',
    config: { availableTools: ['Browser'] },
    context: {
      sessionId: 'conv-1',
      cwd: '/tmp/x',
      workspace: '/tmp/x',
      agentId: 'agent-1',
      runId: 'parent-run',
      abortSignal: new AbortController().signal,
    },
  } as never;
}

describe('withSubagentRunOwner surface cleanup', () => {
  beforeEach(() => {
    mocks.endRun.mockClear();
    mocks.unregister.mockClear();
    mocks.runtime = { endRun: mocks.endRun };
  });

  it('ends the auxiliary surface run when the subagent completes', async () => {
    const result = await withSubagentRunOwner(request(), async () => ({ success: true }) as never);
    expect(result).toEqual({ success: true });
    expect(mocks.endRun).toHaveBeenCalledWith({ conversationId: 'conv-1', runId: 'aux-run-1', agentId: 'agent-1' });
    expect(mocks.unregister).toHaveBeenCalledTimes(1);
  });

  it('ends the auxiliary surface run when the subagent throws', async () => {
    await expect(
      withSubagentRunOwner(request(), async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(mocks.endRun).toHaveBeenCalledWith({ conversationId: 'conv-1', runId: 'aux-run-1', agentId: 'agent-1' });
    expect(mocks.unregister).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no surface runtime exists or endRun rejects', async () => {
    mocks.runtime = null;
    await expect(withSubagentRunOwner(request(), async () => ({ success: true }) as never)).resolves.toBeTruthy();
    mocks.runtime = { endRun: vi.fn(async () => { throw new Error('x'); }) };
    await expect(withSubagentRunOwner(request(), async () => ({ success: true }) as never)).resolves.toBeTruthy();
    expect(mocks.unregister).toHaveBeenCalledTimes(2);
  });
});
