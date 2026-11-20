// @vitest-environment jsdom
// 前台 Bash 被运行策略封口（metadata 只有 {code:TOOL_DISABLED_FOR_RUN, bounced:true}，无 skipped）：
// 折叠行读「未执行 · 描述」，展开后原因句只出现一次（FB-1642）；跑过再失败的 Bash 仍是失败措辞。
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { humanizeToolFailureReason } from '../../../src/renderer/utils/toolExecutionPresentation';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const BOUNCED = { code: 'TOOL_DISABLED_FOR_RUN', bounced: true };
const RAW = 'Tool Bash is disabled for this run.';

function bash(description: string, metadata: Record<string, unknown>): ToolCall {
  return {
    id: 'b1', name: 'Bash', arguments: { command: 'ls ~/Downloads', description },
    result: { toolCallId: 'b1', success: false, error: RAW, metadata },
  };
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

describe.each([['zh', zh, '列出下载文件夹'], ['en', en, 'List Downloads folder']] as const)('never-executed foreground Bash (%s)', (lang, t, description) => {
  beforeEach(() => useAppStore.setState({ language: lang }));

  it('collapsed row reads "Not run · description"; expanding does not repeat the reason sentence', () => {
    const toolCall = bash(description, BOUNCED);
    const { container, getByTestId } = render(<ToolCallDisplay toolCall={toolCall} index={0} total={1} />);
    const row = getByTestId('tool-call-row-Bash');
    expect(row.textContent).toContain(`${t.toolStepHumanize.notRunPrefix} · ${description}`);
    expect(row.textContent).not.toContain(t.toolStepHumanize.bashFallback);
    const reason = humanizeToolFailureReason(toolCall, t);
    expect(reason).toBeTruthy();
    expect(count(container.textContent ?? '', reason)).toBe(1);
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(count(container.textContent ?? '', reason)).toBe(1);
  });

  it('a Bash that ran and failed keeps the failure wording', () => {
    const { getByTestId } = render(<ToolCallDisplay toolCall={bash(description, { exitCode: 1, executed: true })} index={0} total={1} />);
    expect(getByTestId('tool-call-row-Bash').textContent).not.toContain(`${t.toolStepHumanize.notRunPrefix} ·`);
  });

  it('group header counts the bounced Bash as not run, never "could not run"', () => {
    const node = { id: 'n1', type: 'tool_call', content: '', timestamp: 1, toolCall: { id: 'b1', name: 'Bash', args: { command: 'ls', description }, success: false, result: RAW, metadata: BOUNCED } } as TraceNode;
    const { getByTestId } = render(<ToolStepGroup nodes={[node]} sessionId="s1" />);
    const head = getByTestId('tool-group-head-label').textContent ?? '';
    expect(head).toBe(`${t.toolStepHumanize.notRunPrefix} · ${description}`);
  });
});
