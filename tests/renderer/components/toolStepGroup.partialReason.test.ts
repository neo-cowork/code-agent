// 部分成功的工具组：第二行只留失败句，不再把「有提醒 · 」粘在句首。
// 圆点的 aria-label 仍是「有提醒」。渲染真实 ToolStepGroup，不另做测试出口。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/stores/appStore', () => {
  const state = {
    processingSessionIds: new Set<string>(),
    openPreview: vi.fn(),
    openSettingsTab: vi.fn(),
    workingDirectory: '/repo/app',
    language: 'zh' as const,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  };
  return {
    useAppStore: (selector?: (s: typeof state) => unknown) =>
      (selector ? selector(state) : state),
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      currentSessionId: 'session-1',
    }),
}));

import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';

const NOT_INITIALIZED_DETAIL = '如果是邮件、日历这类连接，请在能力中心 > 连接器里打开后再试。';

describe('ToolStepGroup partial reason line', () => {
  it('shows only the registered failure sentence when one step failed and one succeeded', () => {
    const nodes: TraceNode[] = [
      {
        id: 'node-read',
        type: 'tool_call',
        content: '',
        timestamp: 1,
        toolCall: {
          id: 'tool-read',
          name: 'Read',
          args: { file_path: '/work/workspace/contract.pdf' },
          result: '合同正文：甲方星河工作室，金额 12000 元。',
          success: true,
        },
      },
      {
        id: 'node-mail',
        type: 'tool_call',
        content: '',
        timestamp: 2,
        toolCall: {
          id: 'tool-mail',
          name: 'mail',
          args: { action: 'list_messages' },
          result: 'Mail connector is not configured in this runtime.',
          success: false,
          metadata: { code: 'NOT_INITIALIZED' },
        },
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(ToolStepGroup, { nodes }),
    );

    expect(html).toContain('aria-label="有提醒"');
    expect(html).toContain(NOT_INITIALIZED_DETAIL.replace('>', '&gt;'));
    expect(html).not.toContain('有提醒 ·');
    expect(html).toContain('data-testid="tool-group-head-label"');
    const head = html.match(/data-testid="tool-group-head-label"[^>]*>([\s\S]*?)<\/span>/);
    expect(head?.[1] ?? '').not.toContain('有提醒');
  });
});
