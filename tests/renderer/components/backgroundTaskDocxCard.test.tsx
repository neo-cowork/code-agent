// @vitest-environment jsdom
// N-FIX-DOCX ... FU1 rework: realrun3 shape — delegate_task turn + is_meta Bash tool messages + backgroundTaskResult.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Message } from '../../../src/shared/contract/message';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

const TASK_ID = 'session-work-1795383409794-2e82vo';
const DOCX = '/work/task/会议纪要.docx';

const messages: Message[] = [
  { id: 'u1', role: 'user', content: '整理成会议纪要，存成 docx', timestamp: 1000 },
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
        output: '后台任务「纪要do」已开始',
        metadata: { sessionTask: { outcome: 'accepted', tasks: [{ taskId: TASK_ID, shortName: '纪要do', status: 'running' }] } },
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
        artifacts: [{ artifactId: 'a-docx', kind: 'document', role: 'deliverable', sourceTool: 'Bash', name: '会议纪要.docx', path: DOCX }],
      },
    }],
  },
  {
    id: 'task-result',
    role: 'system',
    content: '[任务结果] 纪要do｜已完成｜已生成',
    timestamp: 1300,
    metadata: {
      backgroundTaskResult: {
        source: 'agent-result',
        taskId: TASK_ID,
        shortName: '纪要do',
        status: 'completed',
        summary: '已生成',
        artifacts: [{
          artifactId: 'a-docx', kind: 'document', role: 'deliverable', sourceTool: 'Bash', label: '会议纪要.docx', path: DOCX,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 37667,
        }],
      },
    },
  },
  { id: 'a2', role: 'assistant', content: '会议纪要已生成。', timestamp: 1400 },
];

describe('background-task docx card (delegate_task path)', () => {
  afterEach(() => cleanup());

  it('attaches the docx artifact_ownership node to the delegate_task turn and renders the file name', () => {
    const { turns } = projectTurns(messages, 'session-1', false);
    const node = turns.flatMap((turn) => turn.nodes).find((n) => n.id === 'task-result-artifact-ownership');
    expect(node?.turnTimeline?.artifactOwnership).toEqual([
      expect.objectContaining({ kind: 'file', role: 'deliverable', label: '会议纪要.docx', path: DOCX }),
    ]);
    const owner = turns.find((turn) => turn.nodes.some((n) => n.id === 'task-result-artifact-ownership'));
    expect(owner?.nodes.some((n) => n.toolCall?.name === 'delegate_task')).toBe(true);

    render(<TraceNodeRenderer node={node!} sessionId="session-1" />);
    expect(screen.getByText('会议纪要.docx')).toBeTruthy();
  });
});
