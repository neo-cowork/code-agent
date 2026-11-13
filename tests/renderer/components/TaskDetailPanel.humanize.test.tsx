// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskNodeData } from '../../../src/shared/contract/dagVisualization';
import { detectInternalTextLeaks } from '../../../src/shared/humanizeInternalText';
import { TaskDetailPanel } from '../../../src/renderer/components/features/workflow/TaskDetailPanel';

const appState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));
afterEach(cleanup);

const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const callId = 'call_workflow_result_123';
const task: TaskNodeData = {
  taskId: uuid,
  name: '整理资料',
  type: 'agent',
  status: 'completed',
  priority: 'normal',
  retryCount: 0,
  output: { data: { record: uuid, nested: { execution: { call: callId, count: 2 } } } },
};

// jsdom has no rendered innerText. Follow native closed-details semantics,
// keeping the first summary (visible) and excluding only its closed body.
function visibleText(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll('details:not([open])')) {
    const summary = details.querySelector(':scope > summary');
    details.replaceChildren(...(summary ? [summary] : []));
  }
  return copy.textContent ?? '';
}

describe('TaskDetailPanel humanized output', () => {
  it.each(['zh', 'en'] as const)('keeps structured output closed by default in %s', (language) => {
    appState.language = language;
    const { container, getByText } = render(<TaskDetailPanel task={task} onClose={() => {}} />);
    const summary = language === 'zh'
      ? '结构化技术详情已折叠（展开「详情」可查看）'
      : 'Structured details collapsed (expand Details to inspect)';
    expect(container.contains(getByText(summary))).toBe(true);
    const rawJson = JSON.stringify(task.output?.data, null, 2);
    const raw = Array.from(container.querySelectorAll('pre')).find((pre) => pre.textContent === rawJson);
    expect(raw).toBeDefined();
    const details = raw?.closest('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    const visible = visibleText(container);
    process.stdout.write(`[TaskDetailPanel visible ${language}] ${visible}\n`);
    expect(visible).toContain(summary);
    expect(visible).not.toContain(rawJson);
    expect(visible).not.toContain(uuid);
    expect(visible).not.toContain(callId);
    expect(detectInternalTextLeaks(visible)).toEqual([]);

    // Preserve inspectability: opening native details exposes the exact data.
    if (!details) throw new Error('Expected output details');
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    expect(visibleText(container)).toContain(rawJson);
    expect(visibleText(container)).toContain(callId);
  });
});
