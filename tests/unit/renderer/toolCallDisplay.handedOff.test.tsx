// @vitest-environment jsdom
// 交接后台的 Bash 步：行上读它交给的后台任务的结局；不挂「后续修改已成功」脚注。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';

const HANDOFF_ID = 'host-handoff:turn-1';
const call: ToolCall = {
  id: 'call-1',
  name: 'Bash',
  arguments: { command: 'rm /tmp/old-report-cache.tmp' },
  result: {
    toolCallId: 'call-1', success: false, error: 'HANDED_OFF_TO_BACKGROUND', duration: 0,
    // recovered: the shape the old projection produced; it must not leak a success footnote
    metadata: { skipped: true, bounced: true, recovered: true, code: 'HANDED_OFF_TO_BACKGROUND', handoffTaskToolCallId: HANDOFF_ID },
  },
};
const mediaContext = { sessionId: 's1' } as never;

function task(over: Partial<Task>): Task {
  return {
    id: 'session-work-1', sessionId: 's1', toolCallId: HANDOFF_ID, source: 'session', title: '交接',
    status: 'completed', createdAt: 1, updatedAt: 2, events: [], outputRefs: [], ...over,
  } as Task;
}

describe.each(['zh', 'en'] as const)('ToolCallDisplay · handed-off Bash step (%s)', (lang) => {
  beforeEach(() => useAppStore.setState({ language: lang }));
  afterEach(() => {
    cleanup();
    useBackgroundTaskStore.setState({ tasks: [] });
    useAppStore.setState({ language: 'zh' });
  });
  const recovered = lang === 'zh' ? '后续修改已成功' : 'A later edit succeeded';

  it('failed DELETE_INCOMPLETE task: shows its reason and no recovered footnote', () => {
    useBackgroundTaskStore.setState({ tasks: [task({ status: 'failed', failure: { message: 'DELETE_INCOMPLETE', reason: 'DELETE_INCOMPLETE' } })] });
    const { container } = render(<ToolCallDisplay toolCall={call} index={0} total={1} mediaContext={mediaContext} />);
    expect(container.querySelector('[data-testid="handoff-task-failure"]')?.textContent)
      .toMatch(lang === 'zh' ? /删除没有成功，文件还在/ : /deletion did not succeed/i);
    expect(container.querySelector('[data-testid="tool-call-recovered-note"]')).toBeNull();
    expect(container.textContent).not.toContain(recovered);
  });

  it('completed task: no failure line and no recovered footnote', () => {
    useBackgroundTaskStore.setState({ tasks: [task({ status: 'completed' })] });
    const { container } = render(<ToolCallDisplay toolCall={call} index={0} total={1} mediaContext={mediaContext} />);
    expect(container.querySelector('[data-testid="handoff-task-failure"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-call-recovered-note"]')).toBeNull();
    expect(container.textContent).not.toContain(recovered);
  });
});
