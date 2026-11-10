import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

const loggerState = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: loggerState,
  createLogger: () => loggerState,
}));

import { getSubagentPipeline, resetSubagentPipeline } from '../../../src/host/agent/subagentPipeline';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

const BASH_DEF = {
  name: 'Bash',
  description: 'Execute bash command',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  requiresPermission: true,
  permissionLevel: 'execute' as const,
};

const WRITE_DEF = {
  name: 'Write',
  description: 'Write file',
  inputSchema: {
    type: 'object',
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
  requiresPermission: true,
  permissionLevel: 'write' as const,
};

function buildPipelineRuntime(input: {
  preset?: 'development' | 'strict' | 'ci';
  workingDirectory?: string;
  requestPermission?: (req: Record<string, unknown>) => Promise<boolean>;
}) {
  const workingDirectory = input.workingDirectory ?? '/tmp/workbench';
  const preset = input.preset ?? 'development';
  const pipeline = getSubagentPipeline();
  const pipelineContext = pipeline.createContext(
    {
      name: 'subagent-worker',
      prompt: 'worker',
      tools: ['Bash', 'Write'],
      permissionPreset: preset,
    },
    workingDirectory,
  );
  const permissionRequest = vi.fn(input.requestPermission ?? (async () => true));
  const context = {
    sessionId: 'session-pipeline-gate',
    cwd: workingDirectory,
    resolver: { getDefinition: resolverState.getDefinition },
    permission: { request: permissionRequest },
    events: { emit: vi.fn() },
    abortSignal: new AbortController().signal,
  } as unknown as SubagentExecutionContext;

  const runtime = createSubagentToolRuntime({
    context,
    sessionId: 'session-pipeline-gate',
    effectiveMode: 'default',
    identity: { agentId: 'agent-1', runId: 'run-1', parentToolUseId: 'parent-tool-1' },
    allowedToolNames: new Set(['Bash', 'Write']),
    policyName: preset,
    checkToolExecution: (request) => pipeline.checkToolExecution(pipelineContext, request),
  });
  runtime.executor.setAuditEnabled(false);

  return {
    ...runtime,
    pipeline,
    pipelineContext,
    permissionRequest,
  };
}

describe('subagent pipeline gate & approval bubble-up (N-SUBAGENT-APPROVAL-BUBBLE-UP-PIPELINE-GATE)', () => {
  beforeEach(() => {
    resetSubagentPipeline();
    resetPermissionModeManager();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    loggerState.warn.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => {
      if (name === 'Bash' || name === 'bash') return BASH_DEF;
      if (name === 'Write' || name === 'write_file') return WRITE_DEF;
      return undefined;
    });
    resolverState.execute.mockResolvedValue({ success: true, output: 'file1.txt\nfile2.txt' });
  });

  it('allows development preset Bash `ls` (no path) through the pipeline gate and executes via the normal pipeline', async () => {
    const { executor, policy, pipeline, pipelineContext, permissionRequest } = buildPipelineRuntime({
      preset: 'development',
    });

    const directCheck = pipeline.checkToolExecution(pipelineContext, {
      toolName: 'Bash',
      permissionLevel: 'execute',
      command: 'ls',
    });
    expect(directCheck.allowed).toBe(true);

    const result = await executor.execute(
      'Bash',
      { command: 'ls' },
      { sessionId: 'session-pipeline-gate', subagentPolicy: policy },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('file1.txt\nfile2.txt');
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    expect(permissionRequest).not.toHaveBeenCalled();
  });

  it('forwards a non-auto-approved command that requires approval to context.permission.request', async () => {
    const { executor, policy, permissionRequest } = buildPipelineRuntime({
      preset: 'development',
      requestPermission: async () => true,
    });

    const result = await executor.execute(
      'Bash',
      { command: 'npm publish --tag beta' },
      { sessionId: 'session-pipeline-gate', subagentPolicy: policy },
    );

    expect(permissionRequest).toHaveBeenCalledTimes(1);
    expect(permissionRequest).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      runId: 'run-1',
      parentToolUseId: 'parent-tool-1',
      tool: 'Bash',
      type: 'command',
    }));
    expect(result.success).toBe(true);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('surfaces blocked command hard-deny reason prefixed by policy name in ToolExecutor error and log', async () => {
    const { executor, policy } = buildPipelineRuntime({
      preset: 'development',
    });

    const result = await executor.execute(
      'Bash',
      { command: 'rm -rf /' },
      { sessionId: 'session-pipeline-gate', subagentPolicy: policy },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Denied by subagent permission policy (development): Command is blocked: rm -rf / (Bash)',
    );
    expect(loggerState.warn).toHaveBeenCalledWith(
      'Denied by subagent permission policy (development): Command is blocked: rm -rf / (Bash)',
      expect.objectContaining({
        toolName: 'Bash',
        policy: 'development',
        reason: 'Command is blocked: rm -rf /',
      }),
    );
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it.each(['strict', 'development'] as const)('never lets the classifier auto-approve an out-of-workspace temp-dir Write in %s mode', async (preset) => {
    const tempPath = '/tmp/subagent-outside-gate.sh';
    const { executor, policy, permissionRequest } = buildPipelineRuntime({
      preset,
      workingDirectory: '/work/project',
      requestPermission: async () => false,
    });

    const result = await executor.execute(
      'Write',
      { file_path: tempPath, content: 'echo hi' },
      { sessionId: 'session-pipeline-gate', subagentPolicy: policy },
    );

    expect(permissionRequest).toHaveBeenCalledTimes(1);
    expect(permissionRequest).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'Write', details: expect.objectContaining({ path: tempPath }), forceConfirm: true,
    }));
    expect(result.success).toBe(false);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it.each(['strict', 'development'] as const)('parks an out-of-workspace Write until approve once in %s mode', async (preset) => {
    const workingDirectory = '/work/project';
    const outsidePath = '/work/outside/approve.txt';
    let approveOnce!: (allowed: boolean) => void;
    const { executor, policy, permissionRequest } = buildPipelineRuntime({
      preset,
      workingDirectory,
      requestPermission: () => new Promise<boolean>((resolve) => { approveOnce = resolve; }),
    });

    const execution = executor.execute(
      'Write',
      { file_path: outsidePath, content: 'requested outside content' },
      { sessionId: 'session-pipeline-gate', subagentPolicy: policy },
    );

    await vi.waitFor(() => expect(permissionRequest).toHaveBeenCalledTimes(1));
    expect(permissionRequest).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      runId: 'run-1',
      parentToolUseId: 'parent-tool-1',
      tool: 'Write',
      type: 'file_write',
      details: expect.objectContaining({ path: outsidePath }),
      forceConfirm: true,
    }));
    expect(resolverState.execute).not.toHaveBeenCalled();
    approveOnce(true);

    expect((await execution).success).toBe(true);
    expect(resolverState.execute).toHaveBeenCalledExactlyOnceWith('Write', expect.objectContaining({
      file_path: outsidePath,
      content: 'requested outside content',
    }), expect.anything());
  });

  it('returns explicit refusal for a denied out-of-workspace Write without executing a substitute', async () => {
    const outsidePath = '/work/outside/refused.txt';
    const { executor, policy, permissionRequest } = buildPipelineRuntime({
      preset: 'development',
      workingDirectory: '/work/project',
      requestPermission: async () => false,
    });

    const result = await executor.execute(
      'Write',
      { file_path: outsidePath, content: 'must not be written' },
      { sessionId: 'session-pipeline-gate', subagentPolicy: policy },
    );

    expect(permissionRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      tool: 'Write',
      details: expect.objectContaining({ path: outsidePath }),
      forceConfirm: true,
    }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/denied by user/i);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });
});
