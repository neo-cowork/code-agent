import { beforeEach, describe, expect, it, vi } from 'vitest';

const toolExecutorState = vi.hoisted(() => ({
  config: undefined as undefined | {
    requestPermission: (request: {
      forceConfirm?: boolean;
      type: 'command';
      tool: 'Bash';
      details: Record<string, unknown>;
    }) => Promise<boolean>;
  },
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  buildProfilePrompt: vi.fn(() => 'subagent-prompt'),
}));

vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class ToolExecutor {
    constructor(config: typeof toolExecutorState.config) {
      toolExecutorState.config = config;
    }
  },
}));

import {
  buildChildContext,
  type ChildContextConfig,
  type ParentContext,
} from '../../../src/host/agent/childContext';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';

const childConfig: ChildContextConfig = {
  agentType: 'coder',
  allowedTools: ['Bash'],
};

function parentContext(permissionMode: string): ParentContext {
  return {
    rules: [],
    memory: [],
    hooks: [],
    skills: [],
    mcpConnections: [],
    permissionMode,
    availableTools: ['Bash'],
  };
}

describe('child permission mode inheritance', () => {
  beforeEach(() => {
    toolExecutorState.config = undefined;
  });

  it.each([
    'default',
    'acceptEdits',
    'bypassPermissions',
    'readOnly',
    'plan',
  ])('inherits parent mode %s when the child does not declare one', (permissionMode) => {
    const child = buildChildContext(childConfig, parentContext(permissionMode));

    expect(child.permissions.effectiveMode).toBe(permissionMode);
    expect(child.permissions.canEscalate).toBe(false);
  });

  it('keeps the stricter child-declared mode', () => {
    const child = buildChildContext(
      { ...childConfig, mode: 'plan' },
      parentContext('bypassPermissions'),
    );

    expect(child.permissions.effectiveMode).toBe('plan');
    expect(child.permissions.canEscalate).toBe(false);
  });

  it('uses the inherited bypass mode to auto-approve ordinary Bash but forwards forced confirmation', async () => {
    const child = buildChildContext(childConfig, parentContext('bypassPermissions'));
    const permissionRequest = vi.fn(async () => false);

    createSubagentToolRuntime({
      context: {
        sessionId: 'session-inherited-bypass',
        cwd: '/tmp/workbench',
        resolver: { getDefinition: vi.fn() },
        permission: { request: permissionRequest },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
      } as any,
      sessionId: 'session-inherited-bypass',
      effectiveMode: child.permissions.effectiveMode,
      identity: { agentId: 'child-1', runId: 'run-1', parentToolUseId: 'parent-tool-1' },
      allowedToolNames: new Set(child.toolPool),
      checkToolExecution: vi.fn(() => true),
    });

    expect(toolExecutorState.config).toBeDefined();
    const requestPermission = toolExecutorState.config!.requestPermission;

    await expect(requestPermission({
      type: 'command',
      tool: 'Bash',
      details: { command: 'mkdir -p out && echo hi > out/a.txt' },
      forceConfirm: false,
    })).resolves.toBe(true);
    expect(permissionRequest).not.toHaveBeenCalled();

    await expect(requestPermission({
      type: 'command',
      tool: 'Bash',
      details: { command: 'dangerous command' },
      forceConfirm: true,
    })).resolves.toBe(false);
    expect(permissionRequest).toHaveBeenCalledTimes(1);
    expect(permissionRequest).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'child-1',
      forceConfirm: true,
      parentToolUseId: 'parent-tool-1',
      runId: 'run-1',
      tool: 'Bash',
      type: 'command',
    }));
  });
});
