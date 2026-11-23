// @vitest-environment jsdom
// ============================================================================
// GUI 接管披露 · renderer 渲染（N-CUA-HOST-GUI-DISCLOSURE）
//
// 历史重放形状（TraceNode.toolCall → traceTerminalToolCall → ToolCallDisplay）：
// 披露渲染成调用卡之前的一句话，zh/en 各自词条、{app} 插值；无披露的调用卡
// 不多出这行。这里不做 UI 断言以外的行为验证，只钉「持久化披露可见」。
// ============================================================================
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({ t: i18nState.language === 'en' ? en : zh, language: i18nState.language }),
  };
});

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/index';
import { traceTerminalToolCall } from '../../../src/renderer/utils/toolCallTerminalState';

function replayedToolCall(node: TraceNode['toolCall']): Parameters<typeof ToolCallDisplay>[0]['toolCall'] {
  return traceTerminalToolCall(node!);
}

function disclosureLine(html: string): string {
  const match = html.match(/<div[^>]*data-testid="gui-takeover-disclosure"[^>]*>([\s\S]*?)<\/div>/);
  expect(match, 'gui-takeover-disclosure line should render').toBeTruthy();
  return match![1]
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

describe('ToolCallDisplay · GUI 接管披露（历史重放）', () => {
  it('持久化的披露渲染成调用卡之前的一句中文，{app} 用应用名插值', () => {
    i18nState.language = 'zh';
    const html = renderToStaticMarkup(React.createElement(ToolCallDisplay, {
      toolCall: replayedToolCall({
        id: 'cu-1',
        name: 'computer_use',
        args: { action: 'click', targetApp: 'Keynote' },
        success: true,
        guiTakeoverDisclosure: { code: 'gui_takeover', app: 'Keynote' },
      }),
      index: 0,
      total: 1,
    }));
    expect(disclosureLine(html)).toBe('接下来我会直接操作「Keynote」的界面——这件事没有现成的连接器或网页路径可用。');
    // 披露行在调用主行（tool-call-row）之前。
    expect(html.indexOf('gui-takeover-disclosure')).toBeLessThan(html.indexOf('tool-call-row-computer_use'));
  });

  it('英文界面渲染英文词条，不残留中文', () => {
    i18nState.language = 'en';
    const html = renderToStaticMarkup(React.createElement(ToolCallDisplay, {
      toolCall: replayedToolCall({
        id: 'cu-1',
        name: 'computer_use',
        args: { action: 'click', targetApp: 'Keynote' },
        success: true,
        guiTakeoverDisclosure: { code: 'gui_takeover', app: 'Keynote' },
      }),
      index: 0,
      total: 1,
    }));
    expect(disclosureLine(html)).toBe("Next I'll operate Keynote directly on screen — there's no connector or browser route for this.");
    expect(disclosureLine(html)).not.toMatch(/[一-鿿]/);
  });

  it('没有披露的调用卡不多出这一行', () => {
    i18nState.language = 'zh';
    const html = renderToStaticMarkup(React.createElement(ToolCallDisplay, {
      toolCall: replayedToolCall({
        id: 'read-1',
        name: 'Read',
        args: { file_path: '/tmp/a.md' },
        success: true,
      }),
      index: 0,
      total: 1,
    }));
    expect(html).not.toContain('gui-takeover-disclosure');
  });
});
