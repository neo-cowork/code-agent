// @vitest-environment jsdom
// N-FIX-RECOVERED-NOTE-ON-SKIPPED-ROW：组头 hover 徽标「已恢复 / Recovered」只数真正
// 失败后被收尾的行；从未执行的 skipped Bash（虽被降级成 recovered）不计入。
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const SKIPPED_META = { skipped: true, bounced: true, code: 'TOOL_DISABLED_FOR_RUN' };

function node(id: string, over: Partial<NonNullable<TraceNode['toolCall']>>): TraceNode {
  return {
    id: `n-${id}`, type: 'tool_call', content: '', timestamp: 1,
    toolCall: { id, name: 'Bash', args: { command: 'ls' }, success: true, ...over },
  } as TraceNode;
}

// 从未执行、被系统关卡封口、随后被同轮成功步降级成 recovered 的 Bash。
const skippedRecovered = (id: string): TraceNode => node(id, {
  success: false, result: 'denied', metadata: SKIPPED_META, recovered: true,
});
// 真失败（Edit 同处重试成功）后被投影层标 recovered 的行。
const realRecoveredEdit = (id: string): TraceNode => node(id, {
  name: 'Edit', args: { file_path: '/tmp/report.md', edits: [{ old_text: '旧', new_text: '新' }] },
  success: false, result: 'File must be read before editing', recovered: true,
});
const read = (id: string): TraceNode => node(id, {
  name: 'Read', args: { file_path: 'notes.txt' }, success: true, result: 'x',
});

function headButton(): HTMLElement {
  return screen.getByTestId('tool-group-head-label').closest('button') as HTMLElement;
}

describe.each(['zh', 'en'] as const)('ToolStepGroup · recovered badge vs skipped rows (%s)', (lang) => {
  beforeEach(() => useAppStore.setState({ language: lang }));
  afterEach(() => {
    cleanup();
    useAppStore.setState({ language: 'zh' });
  });
  const badge = lang === 'zh' ? '已恢复' : 'Recovered';

  it('a group whose only recovered row is a never-executed skipped Bash shows no badge', () => {
    render(<ToolStepGroup nodes={[skippedRecovered('a'), read('r')]} sessionId="s1" />);

    expect((screen.getByTestId('tool-group-head-label').textContent ?? '')).toMatch(/未执行|not run/);
    expect(within(headButton()).queryByText(badge)).toBeNull();
  });

  it('a real recovered row still earns the badge, and a skipped row does not cancel it', () => {
    render(<ToolStepGroup nodes={[realRecoveredEdit('e'), read('r')]} sessionId="s1" />);

    expect(within(headButton()).getByText(badge)).toBeTruthy();

    cleanup();
    render(<ToolStepGroup nodes={[skippedRecovered('a'), realRecoveredEdit('e'), read('r')]} sessionId="s1" />);

    expect(within(headButton()).getByText(badge)).toBeTruthy();
  });
});
