// @vitest-environment jsdom
// N-FIX-STEP-HEADER-AND-STOPPED-ROW-REPEAT ①⑤：单步骤失败/中断只说一句人话。
// 现场（Dev 包）：折叠标题「日历 · 已中断 · 日历 · 查询日程未成功」，展开子行「⊘ 已中断 · 日历 · 查询日程未成功」；
// 其实那一步是日历授权被拒后的环境停车（env_blocked），没有人中断它。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { DurableResumeState } from '../../../src/shared/contract/session';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { buildToolStatusLineCopy } from '../../../src/renderer/utils/toolStatusLinePresentation';
import { languages } from '../../../src/renderer/i18n';

const SESSION = 'session_env_park';
const CALL = 'call_a5da97272b5347e3b7bc5470';

// 现场会话同形：calendar list_events，没有落回任何工具结果（停车时只关未派发的调用）。
function calendarNode(): TraceNode {
  return {
    id: 'node-cal',
    type: 'tool_call',
    content: '',
    timestamp: 1_794_742_898_104,
    toolCall: {
      id: CALL,
      name: 'calendar',
      args: { action: 'list_events', from_ms: 1_794_777_600_000, to_ms: 1_794_863_999_000 },
      shortDescription: 'Use calendar',
    },
  } as TraceNode;
}

function seedSession(durableResume?: DurableResumeState): void {
  useSessionStore.setState({
    currentSessionId: SESSION,
    sessions: [{ id: SESSION, title: 't', createdAt: 1, updatedAt: 1, status: 'interrupted', durableResume }] as never,
  });
}

function rowText(): string {
  return (screen.getByTestId('tool-call-row-calendar').textContent ?? '').replace(/\s+/g, ' ').trim();
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const ENV_PARK: DurableResumeState = {
  runId: 'run-6e266084', mode: 'continue', interruptCause: 'env_blocked', autoResumeCount: 0, maxAutoResumeCount: 3,
  canContinue: true, envBlocked: { class: 'perm_automation', target: 'calendar', toolCallId: CALL },
};

describe('single-step tool row: one sentence, connector once, one terminal', () => {
  beforeEach(() => {
    useAppStore.setState({ language: 'zh', processingSessionIds: new Set(), isProcessing: false });
  });
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ currentSessionId: null, sessions: [] });
  });

  it('① stale interrupted calendar step: one row, 日历 once, 已中断 without a second 未成功, no group header repeating it', () => {
    seedSession(undefined);
    render(<ToolStepGroup nodes={[calendarNode()]} sessionId={SESSION} />);
    expect(screen.queryByTestId('tool-group-head-label')).toBeNull();
    const text = rowText();
    expect(text).toMatchInlineSnapshot(`"⊘已中断 ·日历 · 查询日程"`);
    expect(count(text, '日历')).toBe(1);
    expect(text).not.toContain('未成功');
  });

  it('⑤ env_blocked park: the step says what it waits for — never 已中断 — and names the connector once', () => {
    seedSession(ENV_PARK);
    render(<ToolStepGroup nodes={[calendarNode()]} sessionId={SESSION} />);
    expect(screen.queryByTestId('tool-group-head-label')).toBeNull();
    const text = rowText();
    expect(text).toMatchInlineSnapshot(`"等你允许日历 ·查询日程"`);
    // 等待不是中断：沙漏图标，不是禁止符号 ⊘
    expect(screen.getByTestId('env-waiting-icon')).toBeTruthy();
    expect(screen.getByTestId('tool-call-row-calendar').textContent).not.toContain('⊘');
    expect(count(text, '日历')).toBe(1);
    expect(text).not.toMatch(/中断|未成功/);
  });

  it('⑤ env park only relabels its own step; another stale step in the same session stays interrupted', () => {
    seedSession({ ...ENV_PARK, envBlocked: { class: 'perm_automation', target: 'calendar', toolCallId: 'some-other-call' } });
    render(<ToolStepGroup nodes={[calendarNode()]} sessionId={SESSION} />);
    expect(rowText()).toContain('已中断');
  });

  it('① shared line assembler: connector-prefixed failed action keeps exactly one terminal word', () => {
    const t = languages.zh;
    const toolCall = { name: 'calendar', arguments: { action: 'list_events' }, shortDescription: 'Use calendar' };
    expect(buildToolStatusLineCopy({ status: 'interrupted', toolCall }, t).line).toBe('已中断 · 日历 · 查询日程');
    expect(buildToolStatusLineCopy({ status: 'interrupted', toolCall, envWaitingTarget: '日历' }, t).line).toBe('等你允许日历 · 查询日程');
  });
});
