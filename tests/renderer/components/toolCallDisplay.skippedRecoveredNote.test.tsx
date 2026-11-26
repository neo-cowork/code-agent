// @vitest-environment jsdom
// N-FIX-RECOVERED-NOTE-ON-SKIPPED-ROW：被系统关卡拦下、从未执行的 Bash（metadata.skipped）
// 即使被投影层降级成 recovered，也不是「失败后恢复」——不得挂「后续修改已成功」脚注；
// 真失败后被重试收尾的 Edit 照旧保留脚注。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const SKIPPED_META = { skipped: true, bounced: true, code: 'TOOL_DISABLED_FOR_RUN', recovered: true };

// 与 bouncedToolCallSeal 封口 + markRecoveredFailures 降级后的形状一致：
// result.metadata 同时带 skipped（从未执行）与 recovered（后续成功步收尾）。
function makeSkippedRecoveredBash(): ToolCall {
  return {
    id: 'bash-skipped',
    name: 'Bash',
    arguments: { command: 'wc -l notes.txt' },
    result: { toolCallId: 'bash-skipped', success: false, error: 'denied', metadata: SKIPPED_META },
  };
}

function makeRecoveredEdit(): ToolCall {
  return {
    id: 'edit-failed',
    name: 'Edit',
    arguments: { file_path: '/tmp/report.md', edits: [{ old_text: '旧段落', new_text: '新段落' }] },
    result: { toolCallId: 'edit-failed', success: false, error: 'File must be read before editing', metadata: { recovered: true } },
  };
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe.each(['zh', 'en'] as const)('ToolCallDisplay · skipped recovered Bash row (%s)', (lang) => {
  beforeEach(() => useAppStore.setState({ language: lang }));
  const footnote = lang === 'zh' ? '后续修改已成功' : 'A later edit succeeded';

  it('never-executed skipped Bash (degraded to recovered) carries no recovered footnote', () => {
    const { container } = render(<ToolCallDisplay toolCall={makeSkippedRecoveredBash()} index={0} total={1} />);

    expect(container.querySelector('[data-testid="tool-call-recovered-note"]')).toBeNull();
    expect(container.textContent).not.toContain(footnote);
  });
});

describe('ToolCallDisplay · real recovered row keeps the footnote', () => {
  beforeEach(() => useAppStore.setState({ language: 'zh' }));

  it('an Edit failure later retried successfully still shows 后续修改已成功', () => {
    const { container } = render(<ToolCallDisplay toolCall={makeRecoveredEdit()} index={0} total={1} />);

    const note = container.querySelector('[data-testid="tool-call-recovered-note"]');
    expect(note?.textContent).toBe('后续修改已成功');
    expect(container.textContent).not.toContain('未成功');
  });
});
