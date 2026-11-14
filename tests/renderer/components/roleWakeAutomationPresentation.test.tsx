// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { expertZh, expertEn } from '../../../src/renderer/i18n/expert';

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/MessageContent', () => ({ MessageContent: ({ content }: { content: string }) => <div data-testid="automation-content">{content}</div> }));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/index', () => ({ ToolCallDisplay: () => null }));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview', () => ({ AttachmentDisplay: () => null }));
vi.mock('../../../src/renderer/components/features/chat/ExpandableContent', () => ({ ExpandableContent: () => null }));
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });
it.each(['zh', 'en'] as const)('%s localizes the persisted role-wake automation summary at its chat sink', (language) => {
  useAppStore.setState({ language });
  const labels = (language === 'zh' ? expertZh : expertEn).expert.roleDetail.historyDecision;
  for (const decision of ['advance', 'report', 'suggest'] as const) {
    const node: TraceNode = {
      id: 'automation-test', type: 'assistant_text', timestamp: 1,
      content: `Automation completed\n[${decision}] Weekly definitions aligned\nResult session: report`,
      metadata: { automation: { automationId: 'role_wake:report', automationType: 'role_wake', event: 'completed', sourceSessionId: 'source', status: 'completed', title: 'Weekly reporting' } },
    };
    render(<TraceNodeRenderer node={node} />);
    expect(screen.getByTestId('automation-content').textContent).toContain(labels[decision] + ' Weekly definitions aligned');
    expect(screen.getByTestId('automation-content').textContent).not.toContain(`[${decision}]`);
    expect(node.content).toContain(`[${decision}]`);
    cleanup();
    render(<TraceNodeRenderer node={{ ...node, metadata: undefined }} />);
    expect(screen.getByTestId('automation-content').textContent).toContain(`[${decision}]`);
    cleanup();
  }
});

it.each(['zh', 'en'] as const)('%s humanizes legacy trigger labels and scaffolds at the automation chat sink', (language) => {
  useAppStore.setState({ language });
  const node: TraceNode = {
    id: 'automation-legacy', type: 'assistant_text', timestamp: 1,
    content: 'Automation completed\n主动巡检（event 触发）\n你被定时唤醒。这不是用户发来的消息，用户现在不在。 你的任务： 1. 读你的工作履历',
    metadata: { automation: { automationId: 'role_wake:legacy', automationType: 'role_wake', event: 'completed', sourceSessionId: 'source', status: 'completed', title: 'Weekly reporting' } },
  };
  render(<TraceNodeRenderer node={node} />);
  const text = screen.getByTestId('automation-content').textContent;
  expect(text).toContain(language === 'zh' ? '任务完成后巡检' : 'Check-in after task');
  expect(text).toContain(language === 'zh' ? '例行巡检记录' : 'Check-in recorded');
  expect(text).not.toContain('event 触发');
  expect(text).not.toContain('你被定时唤醒');
  expect(node.content).toContain('event 触发');
});
