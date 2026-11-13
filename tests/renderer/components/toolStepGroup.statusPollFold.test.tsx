import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import type { TraceNode } from '../../../src/shared/contract/trace';

const language = vi.hoisted(() => ({ value: 'zh' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: language.value === 'en' ? en : zh, language: language.value }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({
    openPreview: vi.fn(), openSettingsTab: vi.fn(),
  }),
}));

let sequence = 0;
function statusNode(status = 'running', detail?: string): TraceNode {
  const id = String(++sequence);
  return {
    id: `node-${id}`, type: 'tool_call', content: '', timestamp: sequence,
    toolCall: {
      id: `call-${id}`, name: 'task_status', args: { task_id: `internal-${id}` },
      success: true, result: `internal-${id} [${status}] timestamp=${sequence}`,
      metadata: { sessionTask: {
        outcome: 'status', timestamp: sequence,
        tasks: [{ shortName: '整理周报', status, ...(detail === undefined ? {} : { detail }), id }],
      } },
    },
  };
}
function render(nodes: TraceNode[], defaultExpanded = true): string {
  return renderToStaticMarkup(<ToolStepGroup nodes={nodes} defaultExpanded={defaultExpanded} />);
}
function cardCount(html: string): number {
  return (html.match(/data-testid="tool-call-row-task_status"/g) ?? []).length;
}

describe('ToolStepGroup repeated task_status presentation', () => {
  it('renders three identical results as one card with a 3 suffix, ignoring ids/timestamps', () => {
    const nodes = [statusNode(), statusNode(), statusNode()];
    const original = JSON.stringify(nodes);
    const html = render(nodes);
    expect(cardCount(html)).toBe(1);
    expect(html).toContain('已查看 3 次');
    expect(html).toContain('进行中');
    expect(html).not.toContain('[running]');
    expect(html).not.toContain('internal-');
    expect(JSON.stringify(nodes)).toBe(original);
  });

  it('keeps the folded card and count visible in the default collapsed view', () => {
    const html = render([statusNode(), statusNode(), statusNode()], false);
    expect(cardCount(html)).toBe(1);
    expect(html).toContain('已查看 3 次');
  });

  it('renders running -> running -> completed as two cards', () => {
    const html = render([statusNode(), statusNode(), statusNode('completed')]);
    expect(cardCount(html)).toBe(2);
    expect(html).toContain('已查看 2 次');
    expect(html).toContain('已完成');
  });

  it('does not merge across a different tool', () => {
    const other = statusNode();
    other.toolCall!.name = 'Read';
    const html = render([statusNode(), other, statusNode()]);
    expect(cardCount(html)).toBe(2);
    expect(html).toContain('data-testid="tool-call-row-Read"');
    expect(html).not.toContain('task-status-check-count');
  });

  it('does not merge across an internal tool hidden from the group heading', () => {
    const other = statusNode();
    other.toolCall!.name = 'ToolSearch';
    expect(cardCount(render([statusNode(), other, statusNode()]))).toBe(2);
  });

  it('does not merge changed details or task names', () => {
    const renamed = statusNode('running', '核对数字');
    const payload = renamed.toolCall!.metadata!.sessionTask as { tasks: { shortName: string }[] };
    payload.tasks[0].shortName = '整理会议记录';
    const html = render([statusNode(), statusNode('running', '核对数字'), renamed]);
    expect(cardCount(html)).toBe(3);
    expect(html).not.toContain('task-status-check-count');
  });

  it('compares the entire ordered tasks list', () => {
    const one = statusNode();
    const two = statusNode();
    const three = statusNode();
    const tasks = (node: TraceNode) => (node.toolCall!.metadata!.sessionTask as {
      tasks: { shortName: string; status: string }[];
    }).tasks;
    tasks(two).push({ shortName: '校对周报', status: 'queued' });
    tasks(three).push({ shortName: '校对周报', status: 'completed' });
    expect(cardCount(render([one, two, three]))).toBe(3);
    tasks(three)[1].status = 'queued';
    expect(cardCount(render([two, three]))).toBe(1);
    tasks(three).reverse();
    expect(cardCount(render([two, three]))).toBe(2);
  });

  it('does not fold failed, unfinished or invalid results', () => {
    const failed = statusNode();
    failed.toolCall!.success = false;
    const unfinished = statusNode();
    unfinished.toolCall!.result = undefined;
    const invalid = statusNode();
    invalid.toolCall!.metadata = { sessionTask: { outcome: 'status', tasks: [] } };
    const html = render([statusNode(), failed, unfinished, invalid, statusNode()]);
    expect(cardCount(html)).toBe(5);
    expect(html).not.toContain('task-status-check-count');
  });

  it('does not fold another outcome and does not show a suffix for a single check', () => {
    const accepted = statusNode();
    (accepted.toolCall!.metadata!.sessionTask as { outcome: string }).outcome = 'accepted';
    expect(cardCount(render([statusNode(), accepted, statusNode()]))).toBe(3);
    expect(render([statusNode()])).not.toContain('task-status-check-count');
  });

  it('localizes the repeated-check suffix in English', () => {
    language.value = 'en';
    try {
      const html = render([statusNode(), statusNode(), statusNode()]);
      expect(cardCount(html)).toBe(1);
      expect(html).toContain('checked 3 times');
    } finally {
      language.value = 'zh';
    }
  });
});
