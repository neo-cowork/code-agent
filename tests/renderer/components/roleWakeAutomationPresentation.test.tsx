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
