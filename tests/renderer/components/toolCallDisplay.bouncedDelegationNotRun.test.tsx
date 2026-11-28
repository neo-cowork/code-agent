// @vitest-environment jsdom
// N-FIX-DISPATCH-STEP-REJECTED-IN-REPORT-ROUND-SHOWS-RECOVERED — 生产路径渲染测试：
// projectTurns → ToolStepGroup / ToolCallDisplay（zh + en）。
// 1. v6-2 被拒绝的 delegate_task：标题以「未执行」/ "Not run" 开头，不标 recovered，不挂「后续修改已成功」脚注；
// 2. 同一处重试成功的 Edit / edit_file 仍保留脚注（含默认态与 statusOverride='error' 两处渲染点）；
// 3. bounced Bash 保持 recovered 但无脚注；失败后成功的 WebSearch 保持 recovered 但无脚注；bounced Edit 无脚注。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { traceTerminalToolCall } from '../../../src/renderer/utils/toolCallTerminalState';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const V62_DELEGATE_CALL: ToolCall = {
  id: 'call_9d8d781e69db42f5902667db',
  name: 'delegate_task',
  shortDescription: 'Use delegate_task',
  arguments: {
    lane_key: 'q3-ppt-merge',
    short_name: '合成',
    submission_key: 'q3-ppt-merge-1',
    title: '按 corporate 风格合成 8 页季度汇报 PPT',
    prompt: '按 corporate 风格合成整套 8 页 PPT。',
  },
  result: {
    toolCallId: 'call_9d8d781e69db42f5902667db',
    success: false,
    error: '未执行的动作请遵守以下五条回复规则',
    userMessage: '命令没有运行，相关内容没有改动。我可以先帮你查看要处理的内容，或交给后台任务，操作前会先问你。',
    duration: 0,
    metadata: { skipped: true, bounced: true, code: 'TOOL_DISABLED_FOR_RUN' },
  },
};

function projectToolNodes(toolCalls: ToolCall[], reply = '风格已记下（corporate），但整套 8 页还没开始合成，这一步没执行。') {
  const messages: Message[] = [
    { id: 'u-1', role: 'user', content: 'corporate', timestamp: 100 },
    {
      id: 'a-1',
      role: 'assistant',
      content: '已选定 corporate 风格，我现在开始合成整套 8 页。',
      timestamp: 150,
      toolCalls,
      contentParts: [
        { type: 'text', text: '已选定 corporate 风格，我现在开始合成整套 8 页。' },
        ...toolCalls.map((tc) => ({ type: 'tool_call' as const, toolCallId: tc.id })),
      ],
    },
    {
      id: 'a-2',
      role: 'assistant',
      content: reply,
      timestamp: 250,
      contentParts: [{ type: 'text', text: reply }],
    },
  ];
  const turns = projectTurns(messages, 'web-session-v6-2', false, []).turns;
  return turns[turns.length - 1].nodes.filter((n) => n.type === 'tool_call' && n.toolCall);
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe.each([
  { lang: 'zh' as const, notRunPrefix: '未执行', footnote: '后续修改已成功', failedSummaryToken: '个步骤未成功' },
  { lang: 'en' as const, notRunPrefix: 'Not run', footnote: 'A later edit succeeded', failedSummaryToken: 'failed' },
])('bounced delegation & recovered edit footnote ($lang)', ({ lang, notRunPrefix, footnote, failedSummaryToken }) => {
  beforeEach(() => {
    useAppStore.setState({ language: lang });
  });

  it('v6-2 refused delegate_task renders Not run / 未执行 title and no recovered footnote', () => {
    const nodes = projectToolNodes([V62_DELEGATE_CALL]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].toolCall?.recovered).toBeUndefined();

    const groupView = render(<ToolStepGroup nodes={nodes} sessionId="web-session-v6-2" />);
    const titleEl = groupView.container.querySelector('[data-testid="tool-call-row-delegate_task"] span[title]');
    expect(titleEl).not.toBeNull();
    expect(titleEl?.textContent?.trim().startsWith(notRunPrefix)).toBe(true);
    expect(groupView.container.querySelector('[data-testid="tool-call-recovered-note"]')).toBeNull();
    expect(groupView.container.textContent).not.toContain(footnote);
  });

  it('multi-step ToolStepGroup with Read + refused delegate_task prefixes Not run and excludes it from failure count', () => {
    const readOk: ToolCall = {
      id: 'tc-read-ok',
      name: 'Read',
      arguments: { file_path: '/tmp/outline.md' },
      result: { toolCallId: 'tc-read-ok', success: true, output: '# Outline', duration: 2 },
    };
    const nodes = projectToolNodes([readOk, V62_DELEGATE_CALL]);
    const view = render(<ToolStepGroup nodes={nodes} sessionId="web-session-v6-2" defaultExpanded={false} />);
    expect(view.container.textContent).toContain(notRunPrefix);
    expect(view.container.textContent).not.toContain(failedSummaryToken);
    expect(view.container.textContent).not.toContain(footnote);
  });

  it('Edit that fails then succeeds on the same place shows the recovered footnote at both render sites', () => {
    const editArgs = {
      file_path: '/tmp/outline.md',
      edits: [{ old_text: '草稿', new_text: '定稿' }],
    };
    const nodes = projectToolNodes([
      {
        id: 'tc-edit-fail',
        name: 'Edit',
        arguments: editArgs,
        result: { toolCallId: 'tc-edit-fail', success: false, error: 'File must be read before editing' },
      },
      {
        id: 'tc-edit-ok',
        name: 'Edit',
        arguments: editArgs,
        result: { toolCallId: 'tc-edit-ok', success: true, output: 'updated' },
      },
    ], '已更新大纲。');

    const failedEditNode = nodes.find((n) => n.toolCall?.id === 'tc-edit-fail')!;
    expect(failedEditNode.toolCall?.recovered).toBe(true);
    const adaptedEdit = traceTerminalToolCall(failedEditNode.toolCall!);

    // Site 2 (~line 391): default settled recovered Edit row
    const settled = render(<ToolCallDisplay toolCall={adaptedEdit} index={0} total={1} />);
    const note = settled.container.querySelector('[data-testid="tool-call-recovered-note"]');
    expect(note?.textContent).toBe(footnote);
    cleanup();

    // Site 1 (~line 384): error-status inline span when statusOverride='error'
    const errorSite = render(<ToolCallDisplay toolCall={adaptedEdit} statusOverride="error" index={0} total={1} />);
    expect(errorSite.container.textContent).toContain(footnote);
    cleanup();

    // Bounced Edit never shows the footnote at either render site
    const bouncedEdit: ToolCall = {
      id: 'tc-edit-bounced',
      name: 'Edit',
      arguments: editArgs,
      result: {
        toolCallId: 'tc-edit-bounced',
        success: false,
        error: 'bounced',
        metadata: { bounced: true, skipped: true, code: 'TOOL_DISABLED_FOR_RUN', recovered: true },
      },
    };
    const bouncedDefault = render(<ToolCallDisplay toolCall={bouncedEdit} index={0} total={1} />);
    expect(bouncedDefault.container.querySelector('[data-testid="tool-call-recovered-note"]')).toBeNull();
    expect(bouncedDefault.container.textContent).not.toContain(footnote);
    cleanup();

    const bouncedErrorSite = render(<ToolCallDisplay toolCall={bouncedEdit} statusOverride="error" index={0} total={1} />);
    expect(bouncedErrorSite.container.textContent).not.toContain(footnote);
  });

  it('failed WebSearch followed by success is recovered without showing the edit footnote at either render site', () => {
    const nodes = projectToolNodes([
      {
        id: 'tc-web-fail',
        name: 'WebSearch',
        arguments: { query: '季度汇报参考' },
        result: { toolCallId: 'tc-web-fail', success: false, error: 'HTTP 503' },
      },
      {
        id: 'tc-web-ok',
        name: 'WebSearch',
        arguments: { query: '季度汇报结构' },
        result: { toolCallId: 'tc-web-ok', success: true, output: 'ok' },
      },
    ], '已查到参考结构。');

    const failedSearchNode = nodes.find((n) => n.toolCall?.id === 'tc-web-fail')!;
    expect(failedSearchNode.toolCall?.recovered).toBe(true);
    const adaptedSearch = traceTerminalToolCall(failedSearchNode.toolCall!);

    const settled = render(<ToolCallDisplay toolCall={adaptedSearch} index={0} total={1} />);
    expect(settled.container.querySelector('[data-testid="tool-call-recovered-note"]')).toBeNull();
    expect(settled.container.textContent).not.toContain(footnote);
    cleanup();

    const errorSite = render(<ToolCallDisplay toolCall={adaptedSearch} statusOverride="error" index={0} total={1} />);
    expect(errorSite.container.textContent).not.toContain(footnote);
  });
});
