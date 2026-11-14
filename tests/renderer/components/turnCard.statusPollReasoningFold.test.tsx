import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode, TraceTurn } from '../../../src/shared/contract/trace';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { getTurnThinkingSegments } from '../../../src/renderer/components/features/chat/ThinkingDigestBanner';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({
    processingSessionIds: new Set(), disclosureLevel: 'expert',
    openPreview: vi.fn(), openSettingsTab: vi.fn(),
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector({ currentSessionId: null }),
}));

let sequence = 0;
function status(status = 'running', detail?: string): TraceNode {
  const id = String(++sequence);
  return {
    id: `node-${id}`, type: 'tool_call', content: '', timestamp: sequence,
    toolCall: {
      id: `call-${id}`, name: 'task_status', args: {}, success: true,
      result: `internal-id-${id} [${status}]`,
      metadata: { sessionTask: { outcome: 'status', tasks: [{ shortName: '周报', status, detail }] } },
    },
  };
}
function thinking(content = '', field: 'thinking' | 'reasoning' = 'thinking'): TraceNode {
  const id = String(++sequence);
  return { id: `thinking-${id}`, type: 'assistant_text', content, timestamp: sequence, [field]: `核对状态 ${id}` };
}
function turn(nodes: TraceNode[]): TraceTurn {
  return { turnId: 'status-turn', turnNumber: 1, status: 'completed', startTime: 0, endTime: 100, nodes };
}
function render(nodes: TraceNode[]): string {
  return renderToStaticMarkup(<TurnCard turn={turn(nodes)} defaultExpanded isLastTurn />);
}
const cards = (html: string) => (html.match(/data-testid="tool-call-row-task_status"/g) ?? []).length;

describe('TurnCard → grouping → ToolStepGroup status polls separated by reasoning', () => {
  it('folds three identical reads across thinking/reasoning into one card with suffix 3', () => {
    const nodes = [status(), thinking(), status(), thinking('', 'reasoning'), status()];
    const original = JSON.stringify(nodes);
    const html = render(nodes);
    expect(cards(html)).toBe(1);
    expect(html).toContain('已查看 3 次');
    expect(html).toContain('进行中');
    expect(html).not.toContain('internal-id-');
    expect(html).not.toContain('[running]');
    expect(html).toContain('data-testid="thinking-digest"');
    expect(getTurnThinkingSegments(turn(nodes)).map((segment) => segment.id)).toEqual([nodes[1].id, nodes[3].id]);
    expect(JSON.stringify(nodes)).toBe(original);
  });

  it('never crosses assistant text, even if that node also carries thinking', () => {
    const html = render([status(), thinking('还在核对来源。'), status()]);
    expect(cards(html)).toBe(2);
    expect(html).not.toContain('已查看 2 次');
    expect(html).toContain('还在核对来源');
  });

  it('keeps running → thinking → completed as two cards', () => {
    const html = render([status(), thinking(), status('completed')]);
    expect(cards(html)).toBe(2);
    expect(html).not.toContain('task-status-check-count');
    expect(html).toContain('已完成');
  });

  it('never crosses a non-status tool separated by thinking', () => {
    const other = status();
    other.toolCall!.name = 'Read';
    const html = render([status(), thinking(), other, thinking(), status()]);
    expect(cards(html)).toBe(2);
    expect(html).toContain('data-testid="tool-call-row-Read"');
    expect(html).not.toContain('task-status-check-count');
  });

  it('preserves status changes between repeated runs', () => {
    const html = render([status(), thinking(), status(), thinking(), status('completed'), thinking(), status('completed')]);
    expect(cards(html)).toBe(2);
    expect(html.match(/已查看 2 次/g)).toHaveLength(2);
  });

  it('does not bridge a changed detail or a failed status read', () => {
    expect(cards(render([status(), thinking(), status('running', '正在写周报')]))).toBe(2);
    const failed = status();
    failed.toolCall!.success = false;
    const html = render([status(), thinking(), failed, thinking(), status()]);
    expect(cards(html)).toBe(3);
    expect(html).not.toContain('task-status-check-count');
  });
});
