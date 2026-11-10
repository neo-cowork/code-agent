import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

let language: 'zh' | 'en' = 'zh';
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: language === 'zh' ? zh : en, language }),
}));

vi.mock('../../../src/renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({ node }: { node: { type: string; content?: string } }) => (
    React.createElement('div', null, node.content || node.type)
  ),
}));

vi.mock('../../../src/renderer/components/features/chat/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
  getRunningToolStartTime: () => null,
  getRunningSubagentCount: () => 0,
  getStreamingWaitingReason: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

describe('TurnCard HTTP failure phase', () => {
  it.each(['zh', 'en'] as const)('%s failure never claims a generated reply', locale => {
    language = locale;
    const turn: TraceTurn = {
      turnNumber: 1, turnId: 'failed-send', status: 'error', startTime: 100, endTime: 200,
      nodes: [
        { id: 'user', type: 'user', content: '整理照片', timestamp: 100, metadata: { sendFailed: true } },
        { id: 'failure', type: 'assistant_text', content: (locale === 'zh' ? zh : en).serverConnection.requestFailed, timestamp: 200 },
      ],
    };
    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn }));
    expect(html).toContain('data-testid="turn-run-header"');
    expect(html).toContain((locale === 'zh' ? zh : en).turnRun.status.blocked);
    expect(html).not.toContain('回复已生成');
    expect(html).not.toContain('Reply generated');
  });

  it.each(['zh', 'en'] as const)('%s successful reply keeps completed presentation and localizes its phase during cleanup', locale => {
    language = locale;
    const turn: TraceTurn = {
      turnNumber: 1, turnId: 'success', status: 'completed', startTime: 100, endTime: 200,
      nodes: [{ id: 'reply', type: 'assistant_text', content: 'Photos are ready.', timestamp: 200 }],
    };
    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn }));
    expect(html).toContain('Photos are ready.');
    expect(html).not.toContain('data-testid="turn-run-header"');
    const cleanup = renderToStaticMarkup(React.createElement(TurnCard, { turn, sessionStatus: 'cancelling' }));
    expect(cleanup).toContain(locale === 'zh' ? '回复已生成' : 'Reply generated');
    if (locale === 'en') expect(cleanup).not.toContain('回复已生成');
  });
});
