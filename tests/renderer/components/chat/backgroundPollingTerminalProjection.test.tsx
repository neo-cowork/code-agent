// @vitest-environment jsdom

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import type { Task } from '../../../../src/shared/contract/backgroundTask';
import type { TraceNode } from '../../../../src/shared/contract/trace';
import { AgentErrorPresentation } from '../../../../src/renderer/components/features/chat/AgentErrorCard';
import { ToolStepGroup } from '../../../../src/renderer/components/features/chat/ToolStepGroup';
import { projectTurns } from '../../../../src/renderer/hooks/useTurnProjection';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import { useBackgroundTaskStore } from '../../../../src/renderer/stores/backgroundTaskStore';
import { useSessionStore } from '../../../../src/renderer/stores/sessionStore';
import { hydrateToolCallResults } from '../../../../src/renderer/utils/messageHydration';

const SESSION_ID = 'polling-session';
const DELEGATE_CALL_ID = 'call-delegate-a';
const BASH_CALL_ID = 'call-bash-a';

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task-a',
    source: 'session_command_center',
    sessionId: SESSION_ID,
    toolCallId: DELEGATE_CALL_ID,
    title: '后台执行 sleep 20 并输出 A',
    status: 'completed',
    createdAt: 10,
    updatedAt: 80,
    completedAt: 80,
    events: [],
    outputRefs: [],
    ...overrides,
  };
}

function persistedWakeRows(): Message[] {
  return [
    { id: 'visible-user', role: 'user', content: '后台执行 sleep 20 && echo A', timestamp: 1 },
    {
      id: 'delegate-assistant',
      role: 'assistant',
      content: '我先交给后台执行。',
      timestamp: 10,
      toolCalls: [{
        id: DELEGATE_CALL_ID,
        name: 'delegate_task',
        arguments: { title: '后台执行 sleep 20 并输出 A' },
      }],
    },
    {
      id: 'delegate-result',
      role: 'tool',
      content: 'accepted',
      timestamp: 11,
      toolResults: [{
        toolCallId: DELEGATE_CALL_ID,
        success: true,
        output: 'accepted：后台任务「A」(task-a) 已开始。',
      }],
    },
    { id: 'empty-after-accepted', role: 'assistant', content: '', timestamp: 12 },
    {
      id: 'hidden-wake-user',
      role: 'user',
      content: '后台任务 A 已完成，结果摘要：A。',
      timestamp: 20,
      isMeta: true,
    },
    { id: 'empty-wake-assistant', role: 'assistant', content: '', timestamp: 21, isMeta: true },
  ];
}

function toolNodes(messages: Message[]): TraceNode[] {
  return projectTurns(messages, SESSION_ID, false).turns
    .flatMap((turn) => turn.nodes)
    .filter((node) => node.type === 'tool_call');
}

function renderToolNodes(nodes: TraceNode[]): string {
  render(<>{nodes.map((node) => (
    <ToolStepGroup key={node.id} nodes={[node]} sessionId={SESSION_ID} />
  ))}</>);
  return document.body.textContent ?? '';
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh', processingSessionIds: new Set<string>() });
  useSessionStore.setState({ currentSessionId: SESSION_ID, messages: [], runningSessionIds: new Set<string>() });
  useBackgroundTaskStore.setState({ tasks: [] });
});

afterEach(() => {
  cleanup();
  useBackgroundTaskStore.setState({ tasks: [] });
  useSessionStore.setState({ currentSessionId: null, messages: [], runningSessionIds: new Set<string>() });
  useAppStore.setState({ processingSessionIds: new Set<string>() });
});

describe('后台轮询后的终态投影', () => {
  it('DB 形状会按 toolCallId 水合 accepted 结果，空 wake 回复不生成失败卡', () => {
    const rows = persistedWakeRows();
    const hydrated = hydrateToolCallResults(rows);
    useSessionStore.setState({ messages: hydrated });
    const nodes = toolNodes(hydrated);
    const text = renderToolNodes(nodes);
    const raw = {
      projectedToolCalls: nodes.map((node) => ({
        id: node.toolCall?.id,
        success: node.toolCall?.success,
        result: node.toolCall?.result,
      })),
      assistantTextNodes: projectTurns(hydrated, SESSION_ID, false).turns
        .flatMap((turn) => turn.nodes)
        .filter((node) => node.type === 'assistant_text')
        .map((node) => ({ id: node.id, content: node.content })),
      errorCards: document.querySelectorAll('[role="alert"]').length,
      interruptedRows: document.querySelectorAll('[data-testid="interrupt-timeline-step"]').length,
    };
    console.log('POLL_WAKE_DB_FIXTURE_RAW', JSON.stringify(raw));

    expect(nodes).toHaveLength(1);
    expect(nodes[0].toolCall).toMatchObject({ id: DELEGATE_CALL_ID, success: true });
    expect(nodes[0].toolCall?.result).toContain('accepted');
    expect(raw.errorCards).toBe(0);
    expect(raw.interruptedRows).toBe(0);
    expect(text).not.toContain('已中断');
    expect(text).not.toContain('未成功');
  });

  it('任务台账终态覆盖 live 投影暂缺 result：delegate 与后台 Bash 都不报已中断', () => {
    const rows: Message[] = [
      ...persistedWakeRows().filter((message) => message.id !== 'delegate-result'),
      {
        id: 'bash-assistant',
        role: 'assistant',
        content: '',
        timestamp: 30,
        toolCalls: [{
          id: BASH_CALL_ID,
          name: 'Bash',
          arguments: { command: 'sleep 20 && echo A', run_in_background: true },
        }],
      },
      { id: 'wake-result', role: 'assistant', content: '后台任务 A 已完成，输出 A。', timestamp: 90 },
    ];
    useBackgroundTaskStore.setState({
      tasks: [
        task({}),
        task({
          id: 'shell-a',
          source: 'shell',
          kind: 'shell',
          toolCallId: BASH_CALL_ID,
          title: 'sleep 20 && echo A',
        }),
      ],
    });
    useSessionStore.setState({ messages: rows });
    const nodes = toolNodes(rows);
    const text = renderToolNodes(nodes);
    const raw = {
      terminalTasks: useBackgroundTaskStore.getState().tasks.map(({ toolCallId, status }) => ({ toolCallId, status })),
      projectedToolCalls: nodes.map((node) => ({ id: node.toolCall?.id, hasResult: node.toolCall?.result !== undefined })),
      interruptedRows: document.querySelectorAll('[data-testid="interrupt-timeline-step"]').length,
      text: text.replace(/\s+/g, ' ').trim(),
    };
    console.log('POLL_WAKE_LIVE_GAP_RAW', JSON.stringify(raw));

    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.toolCall?.result === undefined)).toBe(true);
    expect(raw.interruptedRows).toBe(0);
    expect(text).toContain('已完成');
    expect(text).not.toContain('已中断');
    expect(text).not.toContain('未成功');
  });

  it('同一可见用户消息后的隐藏 wake 同因失败最多一张卡，随后完成结果仍可见', () => {
    const failed = (id: string, timestamp: number): Message => ({
      id,
      role: 'assistant',
      content: '',
      timestamp,
      metadata: {
        agentError: {
          category: 'generic',
          code: 'MAX_ITERATIONS_REACHED',
          rawMessage: 'Max iterations reached',
          timestamp,
        },
      },
    });
    const messages: Message[] = [
      { id: 'visible-user', role: 'user', content: '轮询后台任务三次', timestamp: 1 },
      failed('failure-1', 10),
      { id: 'hidden-wake-1', role: 'user', content: '后台任务仍在运行', timestamp: 20, isMeta: true },
      failed('failure-2', 21),
      { id: 'hidden-wake-2', role: 'user', content: '后台任务已完成', timestamp: 30, isMeta: true },
      failed('failure-3', 31),
      { id: 'hidden-wake-3', role: 'user', content: '后台任务 A 已完成，输出 A', timestamp: 40, isMeta: true },
      { id: 'completion', role: 'assistant', content: '后台任务 A 已完成，输出 A。', timestamp: 41 },
    ];
    const projection = projectTurns(messages, SESSION_ID, false);
    const assistantNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'assistant_text');
    render(<>{assistantNodes.flatMap((node) => node.metadata?.agentError ? [(
      <AgentErrorPresentation
        key={node.id}
        error={node.metadata.agentError}
        messageId={node.messageId ?? node.id}
        sessionId={SESSION_ID}
        run={node.agentErrorRun}
      />
    )] : [])}</>);
    const raw = {
      alertCards: document.querySelectorAll('[role="alert"]').length,
      mutedFailureLines: document.querySelectorAll('[data-testid="agent-error-muted-line"]').length,
      completionVisible: assistantNodes.some((node) => node.content === '后台任务 A 已完成，输出 A。'),
      runs: assistantNodes
        .filter((node) => node.metadata?.agentError)
        .map((node) => ({ id: node.id, run: node.agentErrorRun })),
    };
    console.log('POLL_WAKE_REPEAT_FAILURE_RAW', JSON.stringify(raw));

    expect(raw.alertCards).toBeLessThanOrEqual(1);
    expect(raw.completionVisible).toBe(true);
  });

  it('后台完成结果抢占轮询后留下的裸 cancelled 不投成用户停止行', () => {
    const messages: Message[] = [
      { id: 'visible-user', role: 'user', content: '在后台跑测试并查看三次进度', timestamp: 1 },
      {
        id: 'task-result',
        role: 'system',
        content: '[任务结果] TESTS｜completed\n测试通过。',
        timestamp: 20,
        metadata: {
          backgroundTaskResult: {
            source: 'agent-result',
            taskId: 'task-tests',
            shortName: 'TESTS',
            status: 'completed',
            summary: '测试通过。',
          },
        },
      },
      {
        id: 'completion-wake-meta', role: 'user', content: '<system-reminder>1 background task completed</system-reminder>',
        timestamp: 20.5, isMeta: true,
        metadata: {
          automation: {
            automationId: 'background-subagent:polling-session',
            automationType: 'role_wake',
            event: 'stage_ready',
            sourceSessionId: SESSION_ID,
            status: 'running',
          },
        },
      },
      { id: 'preempted-poll', role: 'assistant', content: '[cancelled]', timestamp: 21 },
      { id: 'completion-wake', role: 'user', content: '后台任务 TESTS 已完成，结果摘要：测试通过。', timestamp: 22 },
      { id: 'completion', role: 'assistant', content: '后台测试已经通过。', timestamp: 23 },
    ];
    const projection = projectTurns(messages, SESSION_ID, false);
    const assistantNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'assistant_text');
    const raw = {
      stoppedRows: assistantNodes.filter((node) => node.metadata?.streamInterruptionReason === 'user').length,
      completionVisible: assistantNodes.some((node) => node.content === '后台测试已经通过。'),
      assistantNodes: assistantNodes.map((node) => ({
        id: node.id,
        content: node.content,
        interruptionReason: node.metadata?.streamInterruptionReason,
      })),
    };
    console.log('POLL_WAKE_PREEMPTED_CANCEL_RAW', JSON.stringify(raw));

    expect(raw.stoppedRows).toBe(0);
    expect(raw.completionVisible).toBe(true);
  });

  it('真实用户停止不因无关后台完成结果而被隐藏', () => {
    const messages: Message[] = [
      { id: 'visible-user', role: 'user', content: '我先停止当前命令', timestamp: 1 },
      {
        id: 'unrelated-result',
        role: 'system',
        content: '[任务结果] OTHER｜completed\n另一任务已完成。',
        timestamp: 2,
        metadata: {
          backgroundTaskResult: {
            source: 'agent-result',
            taskId: 'other-task',
            shortName: 'OTHER',
            status: 'completed',
            summary: '另一任务已完成。',
          },
        },
      },
      { id: 'real-stop', role: 'assistant', content: '[cancelled]', timestamp: 3 },
    ];
    const projection = projectTurns(messages, SESSION_ID, false);
    const assistantNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'assistant_text');
    const raw = {
      stoppedRows: assistantNodes.filter((node) => node.metadata?.streamInterruptionReason === 'user').length,
      assistantNodes: assistantNodes.map((node) => ({
        id: node.id,
        content: node.content,
        interruptionReason: node.metadata?.streamInterruptionReason,
      })),
    };
    console.log('POLL_WAKE_REAL_STOP_UNRELATED_RESULT_RAW', JSON.stringify(raw));

    expect(raw.stoppedRows).toBe(1);
  });

  it('后台完成结果先后交错时也不投成用户停止行', () => {
    const messages: Message[] = [
      { id: 'visible-user', role: 'user', content: '在后台跑测试并查看三次进度', timestamp: 1 },
      { id: 'dispatch-wake', role: 'user', content: '后台任务仍在运行', timestamp: 10, isMeta: true },
      { id: 'preempted-poll', role: 'assistant', content: '[cancelled]', timestamp: 11 },
      {
        id: 'task-result',
        role: 'system',
        content: '[任务结果] TESTS｜completed\n测试通过。',
        timestamp: 20,
        metadata: {
          backgroundTaskResult: {
            source: 'agent-result',
            taskId: 'task-tests',
            shortName: 'TESTS',
            status: 'completed',
            summary: '测试通过。',
          },
        },
      },
      { id: 'completion-wake', role: 'user', content: '后台任务 TESTS 已完成，结果摘要：测试通过。', timestamp: 21 },
      { id: 'completion', role: 'assistant', content: '后台测试已经通过。', timestamp: 22 },
    ];
    const projection = projectTurns(messages, SESSION_ID, false);
    const assistantNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'assistant_text');
    const raw = {
      stoppedRows: assistantNodes.filter((node) => node.metadata?.streamInterruptionReason === 'user').length,
      completionVisible: assistantNodes.some((node) => node.content === '后台测试已经通过。'),
      assistantNodes: assistantNodes.map((node) => ({
        id: node.id,
        content: node.content,
        interruptionReason: node.metadata?.streamInterruptionReason,
      })),
    };
    console.log('POLL_WAKE_PREEMPTED_CANCEL_BEFORE_RESULT_RAW', JSON.stringify(raw));

    expect(raw.stoppedRows).toBe(0);
    expect(raw.completionVisible).toBe(true);
  });

  it('真实轮询超时后 spawn_agent 形状不留下运行命令中断行', () => {
    const messages: Message[] = [
      { id: 'real-user', role: 'user', content: '请把项目检查交给后台并查看三次进度', timestamp: 1 },
      {
        id: 'dispatch-1', role: 'assistant', content: '交给后台执行。', timestamp: 2,
        toolCalls: [{ id: 'call-dispatch-1', name: 'delegate_task', arguments: { title: '检查项目' } }],
      },
      {
        id: 'dispatch-1-result', role: 'tool', content: '', timestamp: 3,
        toolResults: [{ toolCallId: 'call-dispatch-1', success: false, error: 'Tool execution timed out after 120000ms without progress' }],
      },
      {
        id: 'status-1', role: 'assistant', content: '', timestamp: 4,
        toolCalls: [{ id: 'call-status-1', name: 'task_status', arguments: {} }],
      },
      {
        id: 'status-1-result', role: 'tool', content: '', timestamp: 5,
        toolResults: [{ toolCallId: 'call-status-1', success: true, output: '当前会话还没有后台任务。' }],
      },
      {
        id: 'dispatch-2', role: 'assistant', content: '交给后台执行。', timestamp: 5.5,
        toolCalls: [{ id: 'call-dispatch-2', name: 'delegate_task', arguments: { title: '检查项目' } }],
      },
      {
        id: 'dispatch-2-result', role: 'tool', content: '', timestamp: 5.75,
        toolResults: [{ toolCallId: 'call-dispatch-2', success: false, error: 'Tool execution timed out after 120000ms without progress' }],
      },
      {
        id: 'spawn', role: 'assistant', content: '', timestamp: 6,
        toolCalls: [{ id: 'call-spawn', name: 'spawn_agent', arguments: { run_in_background: true, role: 'explore', task: '检查项目' } }],
      },
      {
        id: 'spawn-result', role: 'tool', content: '', timestamp: 7,
        toolResults: [{ toolCallId: 'call-spawn', success: true, output: '已在后台启动子 agent，前台不阻塞。' }],
      },
      {
        id: 'status-2', role: 'assistant', content: '再查看一次进度。', timestamp: 7.5,
        toolCalls: [{ id: 'call-status-2', name: 'task_status', arguments: {} }],
      },
      {
        id: 'status-2-result', role: 'tool', content: '', timestamp: 7.75,
        toolResults: [{ toolCallId: 'call-status-2', success: true, output: '当前会话还没有后台任务。' }],
      },
      {
        id: 'max-steps', role: 'assistant', content: '已达本任务的最大步骤上限，工具已停用。', timestamp: 8,
        metadata: { agentError: { code: 'MAX_ITERATIONS_REACHED', category: 'generic' } },
      },
      {
        id: 'background-result', role: 'user', content: '后台任务已完成，结果摘要：检查完成。', timestamp: 9, isMeta: true,
        metadata: { backgroundTaskResult: { source: 'agent-result', taskId: 'subagent-bg', shortName: '检查', status: 'completed', summary: '检查完成。' } },
      },
    ];
    useSessionStore.setState({ messages });
    const hydrated = hydrateToolCallResults(messages);
    const nodes = toolNodes(hydrated);
    const text = renderToolNodes(nodes);
    const raw = {
      toolNodes: nodes.filter((node) => node.type === 'tool_call').map((node) => ({
        id: node.id,
        tool: node.toolCall?.name,
        result: node.toolCall?.result,
        success: node.toolCall?.success,
      })),
      interruptionNodes: nodes.filter((node) => node.metadata?.streamInterruptionReason).map((node) => ({
        id: node.id,
        content: node.content,
        reason: node.metadata?.streamInterruptionReason,
      })),
      interruptedRows: document.querySelectorAll('[data-testid="interrupt-timeline-step"]').length,
      text: text.replace(/\s+/g, ' ').trim(),
    };
    console.log('R3_REAL_POLLING_SHAPE_RAW', JSON.stringify(raw));
    expect(raw.interruptedRows).toBe(0);
    expect(raw.interruptionNodes).toEqual([]);
  });

});
