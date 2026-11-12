import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toolExecutorState = vi.hoisted(() => ({
  config: undefined as undefined | {
    permissionModeOverrideIsInheritedCeiling?: boolean;
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
import { resolveSubagentParentContext } from '../../../src/host/agent/subagentProtocolContext';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import {
  getPermissionModeManager,
  resetPermissionModeManager,
} from '../../../src/host/permissions/modes';
import { beginRunPolicy, endRunPolicy } from '../../../src/host/permissions/runPolicySnapshot';

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
  const activeRunIds = new Set<string>();

  beforeEach(() => {
    toolExecutorState.config = undefined;
    resetPermissionModeManager();
  });

  afterEach(() => {
    for (const runId of activeRunIds) endRunPolicy(runId);
    activeRunIds.clear();
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
    const sessionId = 'session-inherited-bypass';
    getPermissionModeManager().setSessionMode(sessionId, 'bypassPermissions', true);
    const child = buildChildContext(childConfig, parentContext('bypassPermissions'));
    const permissionRequest = vi.fn(async () => false);

    createSubagentToolRuntime({
      context: {
        sessionId,
        cwd: '/tmp/workbench',
        resolver: { getDefinition: vi.fn() },
        permission: { request: permissionRequest },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
      } as any,
      sessionId,
      effectiveMode: child.permissions.effectiveMode,
      identity: { agentId: 'child-1', runId: 'run-1', parentToolUseId: 'parent-tool-1' },
      allowedToolNames: new Set(child.toolPool),
      checkToolExecution: vi.fn(() => true),
    });

    expect(toolExecutorState.config).toBeDefined();
    expect(toolExecutorState.config!.permissionModeOverrideIsInheritedCeiling).toBe(true);
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

  it('inherits the run snapshot instead of an external mid-run session widening', async () => {
    const sessionId = 'session-external-widening';
    const runId = 'run-external-widening';
    const manager = getPermissionModeManager();
    manager.setSessionMode(sessionId, 'default');
    beginRunPolicy(runId, sessionId);
    activeRunIds.add(runId);
    manager.setSessionMode(sessionId, 'bypassPermissions', true, 'external');

    const parent = resolveSubagentParentContext({ sessionId, runId } as any);
    const child = buildChildContext(childConfig, parent);
    const permissionRequest = vi.fn(async () => false);
    createSubagentToolRuntime({
      context: {
        sessionId,
        cwd: '/tmp/workbench',
        resolver: { getDefinition: vi.fn() },
        permission: { request: permissionRequest },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
      } as any,
      sessionId,
      effectiveMode: child.permissions.effectiveMode,
      identity: { agentId: 'child-external', runId, parentToolUseId: 'parent-external' },
      allowedToolNames: new Set(child.toolPool),
      checkToolExecution: vi.fn(() => true),
    });

    expect(parent.permissionMode).toBe('default');
    expect(child.permissions.effectiveMode).toBe('default');
    await expect(toolExecutorState.config!.requestPermission({
      type: 'command',
      tool: 'Bash',
      details: { command: 'echo still asks' },
      forceConfirm: false,
    })).resolves.toBe(false);
    expect(permissionRequest).toHaveBeenCalledTimes(1);
  });

  it('applies a user UI tightening to an already-running bypass child', async () => {
    const sessionId = 'session-ui-tightening';
    const runId = 'run-ui-tightening';
    const manager = getPermissionModeManager();
    manager.setSessionMode(sessionId, 'bypassPermissions', true, 'user-ui');
    beginRunPolicy(runId, sessionId);
    activeRunIds.add(runId);

    const parent = resolveSubagentParentContext({ sessionId, runId } as any);
    const child = buildChildContext(childConfig, parent);
    const permissionRequest = vi.fn(async () => false);
    createSubagentToolRuntime({
      context: {
        sessionId,
        cwd: '/tmp/workbench',
        resolver: { getDefinition: vi.fn() },
        permission: { request: permissionRequest },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
      } as any,
      sessionId,
      effectiveMode: child.permissions.effectiveMode,
      identity: { agentId: 'child-tightening', runId, parentToolUseId: 'parent-tightening' },
      allowedToolNames: new Set(child.toolPool),
      checkToolExecution: vi.fn(() => true),
    });
    const requestPermission = toolExecutorState.config!.requestPermission;

    await expect(requestPermission({
      type: 'command',
      tool: 'Bash',
      details: { command: 'echo before' },
      forceConfirm: false,
    })).resolves.toBe(true);
    expect(permissionRequest).not.toHaveBeenCalled();

    manager.setSessionMode(sessionId, 'default', false, 'user-ui');
    await expect(requestPermission({
      type: 'command',
      tool: 'Bash',
      details: { command: 'echo after' },
      forceConfirm: false,
    })).resolves.toBe(false);
    expect(permissionRequest).toHaveBeenCalledTimes(1);
  });
});
