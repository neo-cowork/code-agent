// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Message } from '../../../src/shared/contract/message';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

const TASK_ID = 'session-work-1795383409794-pptx';
const PPTX = '/work/task/销售汇报.pptx';
const MINUTES = '/work/task/会议纪要.md';

const messages: Message[] = [
  { id: 'u1', role: 'user', content: '后台把销售数据做成 10 页 PPT，并写一份简短纪要，完成后告诉我', timestamp: 1000 },
  {
    id: 'a1',
    role: 'assistant',
    content: '我把这件事交给后台任务去做。',
    timestamp: 1100,
    toolCalls: [{
      id: 'call-delegate',
      name: 'delegate_task',
      arguments: {},
      result: {
        toolCallId: 'call-delegate',
        success: true,
        output: '后台任务「销售汇报」已开始',
        metadata: { sessionTask: { outcome: 'accepted', tasks: [{ taskId: TASK_ID, shortName: '销售汇报', status: 'running' }] } },
      },
    }],
  },
  {
    id: 'bash-tool',
    role: 'tool',
    isMeta: true,
    content: '[]',
    timestamp: 1200,
    toolResults: [{
      toolCallId: 'call-bash',
      success: true,
      output: 'ok',
      metadata: {
        artifacts: [{ artifactId: 'a-pptx', kind: 'document', role: 'deliverable', sourceTool: 'Bash', name: '销售汇报.pptx', path: PPTX }],
      },
    }],
  },
  {
    id: 'write-tool',
    role: 'tool',
    isMeta: true,
    content: '[]',
    timestamp: 1250,
    toolResults: [{
      toolCallId: 'call-write',
      success: true,
      output: 'ok',
      metadata: {
        artifact: { artifactId: 'a-minutes', kind: 'text', role: 'deliverable', sourceTool: 'Write', name: '会议纪要.md', path: MINUTES },
      },
    }],
  },
  {
    id: 'task-result',
    role: 'system',
    content: '[任务结果] 销售汇报｜已完成｜已生成销售汇报和会议纪要',
    timestamp: 1300,
    metadata: {
      backgroundTaskResult: {
        source: 'agent-result',
        taskId: TASK_ID,
        shortName: '销售汇报',
        status: 'completed',
        summary: '已生成销售汇报和会议纪要',
        artifacts: [
          {
            artifactId: 'a-pptx', kind: 'document', role: 'deliverable', sourceTool: 'Bash', label: '销售汇报.pptx', path: PPTX,
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sizeBytes: 37667,
          },
          {
            artifactId: 'a-minutes', kind: 'text', role: 'deliverable', sourceTool: 'Write', label: '会议纪要.md', path: MINUTES,
            mimeType: 'text/markdown', sizeBytes: 268,
          },
        ],
      },
    },
  },
  { id: 'a2', role: 'assistant', content: '已完成：销售汇报.pptx 和 会议纪要.md。', timestamp: 1400 },
];

describe('background-task pptx and minutes cards (delegate_task path)', () => {
  afterEach(() => cleanup());

  it('renders both file cards after the final report that names them', async () => {
    const { turns } = projectTurns(messages, 'session-1', false);
    const node = turns.flatMap((turn) => turn.nodes).find((n) => n.id === 'task-result-artifact-ownership');
    expect(node?.turnTimeline?.artifactOwnership).toEqual([
      expect.objectContaining({ kind: 'file', role: 'deliverable', label: '销售汇报.pptx', path: PPTX }),
      expect.objectContaining({ kind: 'file', role: 'deliverable', label: '会议纪要.md', path: MINUTES }),
    ]);
    const owner = turns.find((turn) => turn.nodes.some((n) => n.id === 'task-result-artifact-ownership'));
    expect(owner?.nodes.some((n) => n.toolCall?.name === 'delegate_task')).toBe(true);
    expect(owner?.nodes.some((n) => n.content === '已完成：销售汇报.pptx 和 会议纪要.md。')).toBe(true);

    render(<TraceNodeRenderer node={node!} sessionId="session-1" />);
    expect(await screen.findByText('销售汇报.pptx')).toBeTruthy();
    expect(await screen.findByText('会议纪要.md')).toBeTruthy();
  });
});
