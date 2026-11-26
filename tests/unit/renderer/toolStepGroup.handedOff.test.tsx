// @vitest-environment jsdom
// 交接后台的 Bash 步：状态取自它交给的后台任务，不读成「已恢复 / 后续修改已成功」，也不数成「没有执行」。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';

const HANDOFF_ID = 'host-handoff:turn-1';
const handedOff: TraceNode = {
  id: 'n-1', type: 'tool_call', content: '', timestamp: 1,
  toolCall: {
    id: 'call-1', name: 'Bash', args: { command: 'rm /tmp/old-report-cache.tmp' }, success: false, result: 'HANDED_OFF_TO_BACKGROUND',
    metadata: { skipped: true, bounced: true, code: 'HANDED_OFF_TO_BACKGROUND', handoffTaskToolCallId: HANDOFF_ID },
  },
} as TraceNode;

function task(over: Partial<Task>): Task {
  return {
    id: 'session-work-1', sessionId: 's1', toolCallId: HANDOFF_ID, source: 'session', title: '交接',
    status: 'completed', createdAt: 1, updatedAt: 2, events: [], outputRefs: [], ...over,
  } as Task;
}

function bodyText(): string {
  return document.body.textContent ?? '';
}

describe.each(['zh', 'en'] as const)('ToolStepGroup · handed-off Bash step (%s)', (lang) => {
  beforeEach(() => useAppStore.setState({ language: lang }));
  afterEach(() => {
    cleanup();
    useBackgroundTaskStore.setState({ tasks: [] });
    useAppStore.setState({ language: 'zh' });
  });
  const recoveredWords = /已恢复|后续修改已成功|Recovered|A later edit succeeded/;
  const notRunWords = /没有执行|did not run|not run/i;

  it('task failed DELETE_INCOMPLETE → no recovered text, the task reason is shown', () => {
    useBackgroundTaskStore.setState({ tasks: [task({ status: 'failed', failure: { message: 'DELETE_INCOMPLETE', reason: 'DELETE_INCOMPLETE' } })] });
    render(<ToolStepGroup nodes={[handedOff]} sessionId="s1" />);
    fireEvent.click(screen.getByTestId('tool-group-head-label').closest('button') as HTMLElement);
    expect(bodyText()).not.toMatch(recoveredWords);
    expect(bodyText()).toMatch(lang === 'zh' ? /删除没有成功，文件还在/ : /deletion did not succeed/i);
  });

  it('task completed → no recovered text and not counted as a command that did not run', () => {
    useBackgroundTaskStore.setState({ tasks: [task({ status: 'completed' })] });
    render(<ToolStepGroup nodes={[handedOff]} sessionId="s1" />);
    expect(bodyText()).not.toMatch(recoveredWords);
    expect(bodyText()).not.toMatch(notRunWords);
  });

  it('no task row → neutral: no recovered, no not-run, no success claim', () => {
    useBackgroundTaskStore.setState({ tasks: [] });
    render(<ToolStepGroup nodes={[handedOff]} sessionId="s1" />);
    expect(bodyText()).not.toMatch(recoveredWords);
    expect(bodyText()).not.toMatch(notRunWords);
  });
});
