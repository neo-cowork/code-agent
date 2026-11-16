import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { HostReasonCode } from '../../../src/shared/contract/permission';
import type { SessionCommandTask } from '../../../src/host/services/commandCenter/sessionCommandCenter';

const orchestratorState = vi.hoisted(() => ({
  messageRuns: [] as Message[][],
}));

const projectionState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    private readonly messages = orchestratorState.messageRuns.shift() ?? [];
    sendMessage = vi.fn().mockResolvedValue(undefined);
    setSessionId = vi.fn();
    setMessages = vi.fn();
    setWorkingDirectory = vi.fn();
    setWorkspaceScopeAuthority = vi.fn();
    getMessages = () => this.messages;
  },
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
  hasInteractiveUi: () => false,
}));

vi.mock('../../../src/host/task/backgroundTaskSessionContext', () => ({
  getBackgroundTaskSessionContext: () => undefined,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ addMessageToSession: projectionState.addMessage }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => ({ ui: { language: projectionState.language } }),
  }),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: (name: string) => {
      if (name === 'Write' || name === 'Edit') return { permissionLevel: 'write' };
      if (name === 'Read' || name === 'read_xlsx') return { permissionLevel: 'read' };
      return undefined;
    },
  }),
}));

import { TaskManager } from '../../../src/host/task/TaskManager';
import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { projectTerminalResult } from '../../../src/host/services/commandCenter/terminalResultProjection';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../src/host/task/backgroundTaskLedger';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

const APPROVAL_ZH = '后台任务没能完成：需要你批准的操作一直没有等到批准，已停止。';
const APPROVAL_EN = 'The background task could not finish: an action that needed your approval was never approved, so it stopped.';
const REPAIR_ZH = '后台任务没能完成：它调用的工具连续出错，已停止。';

function runMessages(input: {
  calls: Array<{
    id: string;
    name: string;
    success: boolean;
    metadata?: Record<string, unknown>;
  }>;
  conclusion: string;
}): Message[] {
  return [
    {
      id: 'assistant-tools',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: input.calls.map((call) => ({ id: call.id, name: call.name, arguments: {} })),
    },
    {
      id: 'tool-results',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolResults: input.calls.map((call) => ({
        toolCallId: call.id,
        success: call.success,
        ...(call.success ? { output: 'ok' } : { error: 'tool failed' }),
        ...(call.metadata ? { metadata: call.metadata } : {}),
      })),
    },
    { id: 'assistant-final', role: 'assistant', content: input.conclusion, timestamp: 3 },
  ];
}

function approvalTimeoutMetadata(): Record<string, unknown> {
  return {
    hostReason: {
      code: HostReasonCode.PermissionDeniedTimeout,
      modelText: 'Permission approval timed out.',
    },
  };
}

function resultCards(): Message[] {
  return projectionState.addMessage.mock.calls
    .map((call) => call[1] as Message)
    .filter((message) => message.metadata?.backgroundTaskResult);
}

async function runProjectedTask(
  messages: Message[],
  expectedStatus: 'completed' | 'failed',
  language: 'zh' | 'en' = 'zh',
) {
  projectionState.language = language;
  orchestratorState.messageRuns.push(messages);
  const manager = new TaskManager({ maxConcurrentTasks: 1 });
  manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
  const center = new SessionCommandCenter(manager, {
    projectTerminalResult,
    persistMemberInput: vi.fn(),
    wakeForegroundBrain: vi.fn(),
  });
  const spawned = await center.spawn({
    sessionId: 'session-1',
    title: 'Read page titles',
    shortName: 'titles',
    laneKey: 'titles',
    submissionKey: 'titles-1',
    prompt: 'read the two page titles',
    workspaceScope: createWorkspaceScope('project-1', [{
      sourceId: 'primary', path: '/work', role: 'primary', access: 'read_write',
    }]),
  });
  if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

  await vi.waitFor(() => expect(center.list('session-1')[0]?.status).toBe(expectedStatus));
  await vi.waitFor(() => expect(resultCards()).toHaveLength(1));
  const task = center.list('session-1')[0];
  const card = resultCards()[0];
  const ledger = getBackgroundTaskLedger().listTasks({ sessionId: 'session-1' })[0];
  center.dispose();
  return { task, card, ledger };
}

describe('background terminal failure projection', () => {
  beforeEach(() => {
    orchestratorState.messageRuns.length = 0;
    projectionState.addMessage.mockReset();
    projectionState.language = 'zh';
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  it('① approval timeout projects a failed task and one plain Chinese sentence', async () => {
    const { task, card, ledger } = await runProjectedTask(runMessages({
      calls: [{ id: 'browser-1', name: 'browser_action', success: false, metadata: approvalTimeoutMetadata() }],
      conclusion: '<tool_call>{"targetRef":"e1"}</tool_call>Approval timed out.',
    }), 'failed');

    expect(task.detail).toBe(APPROVAL_ZH);
    expect(ledger).toMatchObject({ status: 'failed', summary: APPROVAL_ZH });
    expect(card.content).toBe(`[任务结果] titles｜已失败｜${APPROVAL_ZH}`);
    expect(card.metadata?.backgroundTaskResult).toMatchObject({ status: 'failed', summary: APPROVAL_ZH });
    expect(card.content).not.toContain('targetRef');
  });

  it('② exhausted tool-argument repair projects a failed task without raw markup', async () => {
    const { task, card, ledger } = await runProjectedTask(runMessages({
      calls: [{
        id: 'browser-1', name: 'browser_action', success: false, metadata: { repairExhausted: true },
      }],
      conclusion: '<tool-args-repair-exhausted>{"targetRef":"e2"}</tool-args-repair-exhausted>',
    }), 'failed');

    expect(task.detail).toBe(REPAIR_ZH);
    expect(ledger).toMatchObject({ status: 'failed', summary: REPAIR_ZH });
    expect(card.content).toBe(`[任务结果] titles｜已失败｜${REPAIR_ZH}`);
    expect(card.metadata?.backgroundTaskResult).toMatchObject({ status: 'failed', summary: REPAIR_ZH });
    expect(card.content).not.toMatch(/<|targetRef/);
    expect(card.metadata?.backgroundTaskResult?.summary).not.toMatch(/<|targetRef/);
  });

  it('uses the same locale resolution for the English approval-timeout sentence', async () => {
    const { card } = await runProjectedTask(runMessages({
      calls: [{ id: 'browser-1', name: 'Browser', success: false, metadata: approvalTimeoutMetadata() }],
      conclusion: 'The browser approval timed out.',
    }), 'failed', 'en');

    expect(card.content).toBe(`[任务结果] titles｜failed｜${APPROVAL_EN}`);
    expect(card.metadata?.backgroundTaskResult).toMatchObject({ status: 'failed', summary: APPROVAL_EN });
  });

  it('③ keeps an earlier timeout recovered by a later successful browser result completed', async () => {
    const { task, card, ledger } = await runProjectedTask(runMessages({
      calls: [
        { id: 'browser-1', name: 'Browser', success: false, metadata: approvalTimeoutMetadata() },
        { id: 'browser-2', name: 'Browser', success: true },
      ],
      conclusion: 'example.com — Example Domain',
    }), 'completed');

    expect(task.detail).toBe('example.com — Example Domain');
    expect(ledger).toMatchObject({ status: 'completed', summary: 'example.com — Example Domain' });
    expect(card.content).toBe('[任务结果] titles｜已完成｜example.com — Example Domain');
  });

  it('keeps a delivered artifact completed even when the last tool result timed out', async () => {
    const { task, card } = await runProjectedTask(runMessages({
      calls: [{
        id: 'browser-1',
        name: 'Browser',
        success: false,
        metadata: {
          ...approvalTimeoutMetadata(),
          artifact: {
            artifactId: 'titles-1', kind: 'document', role: 'deliverable', sourceTool: 'Browser', path: '/work/titles.md',
          },
        },
      }],
      conclusion: 'The verified titles are in titles.md.',
    }), 'completed');

    expect(task.status).toBe('completed');
    expect(card.metadata?.backgroundTaskResult).toMatchObject({
      status: 'completed', summary: 'The verified titles are in titles.md.',
    });
  });

  it.each(['resultText', 'summary'] as const)('④ strips tool_call and longcat markup from %s through projectTerminalResult', async (field) => {
    const raw = [
      'Page titles:',
      '<tool_call>{"name":"browser_action","arguments":{"targetRef":"e3"}}</tool_call>',
      '<longcat_tool_call>{"name":"browser_action","arguments":{"targetRef":"e4"}}</longcat_tool_call>',
      'Example Domain',
    ].join('\n');
    const task: SessionCommandTask = {
      id: 'task-markup', sessionId: 'session-1', title: 'Read titles', shortName: 'titles',
      laneKey: 'titles', submissionKey: 'titles-markup', prompt: 'read titles',
      workspaceScope: createWorkspaceScope('project-1', [{
        sourceId: 'primary', path: '/work', role: 'primary', access: 'read_write',
      }]),
      status: 'completed', attempt: 1, createdAt: 1, updatedAt: 2, [field]: raw,
    };

    await projectTerminalResult(task, 'completed');

    expect(resultCards()).toHaveLength(1);
    const card = resultCards()[0];
    expect(card.metadata?.backgroundTaskResult?.summary).toBe('Page titles:\n\nExample Domain');
    expect(card.content).not.toMatch(/<\/?(?:tool_call|longcat_tool_call)>|targetRef/);
    expect(card.metadata?.backgroundTaskResult?.summary).not.toMatch(/<\/?(?:tool_call|longcat_tool_call)>|targetRef/);
  });

  it('card strips an unclosed <tool_call> tail (card-only scope)', async () => {
    const { buildSessionTaskResultMessage } = await import('../../../src/host/services/commandCenter/sessionCommandTaskRestartRecovery');
    const card = buildSessionTaskResultMessage(
      { id: 'task-open', shortName: 'titles' }, 'completed',
      'Done.\n<tool_call>{"targetRef":"e6"', 'result-open', 'en',
    );
    expect(card.metadata?.backgroundTaskResult?.summary).toBe('Done.');
    expect(card.content).not.toMatch(/<tool_call>|targetRef/);
  });

  it('cleans the shared builder used by deferred restart recovery', async () => {
    const { buildSessionTaskResultMessage } = await import('../../../src/host/services/commandCenter/sessionCommandTaskRestartRecovery');
    const card = buildSessionTaskResultMessage(
      { id: 'task-restart', shortName: 'titles' },
      'completed',
      'Recovered.\n<tool_call>{"targetRef":"e5"}</tool_call>',
      'result-restart',
      'en',
    );

    expect(card.content).toBe('[任务结果] titles｜finished｜Recovered.');
    expect(card.metadata?.backgroundTaskResult?.summary).toBe('Recovered.');
  });

  it.each([APPROVAL_ZH, APPROVAL_EN, REPAIR_ZH])('keeps the terminal failure notice to one sentence without a URL suffix', async (detail) => {
    const { resolveStoppedTaskOutcome } = await import('../../../src/host/services/commandCenter/sessionTaskStopConclusion');
    expect(resolveStoppedTaskOutcome({ status: 'failed', detail, lastUrl: 'https://example.com' })).toEqual({
      status: 'failed', detail, notice: detail, kind: 'error',
    });
  });
});
