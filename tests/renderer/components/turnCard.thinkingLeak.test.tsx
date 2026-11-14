import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
const dicts = vi.hoisted(() => ({ zh: null as unknown, en: null as unknown }));
dicts.zh = zh;
dicts.en = en;

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: dicts[i18nState.language], language: i18nState.language }),
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
}));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));
vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

const PROSE = 'The user wants to move this plan to a new chat, so I should check the existing sessions first.';
const LEAKY_THINKING = [
  PROSE,
  'I will call delegate_session after list_session_candidates returns a candidateSetId.',
  'Maybe memory_search or MemoryRead helps, ToolSearch and Glob could find tools, AskUserQuestion if unsure.',
  'Options: delegate_existing or create_new; the target session state is active.',
].join('\n');

function renderThinking(language: 'zh' | 'en'): string {
  i18nState.language = language;
  const turn: TraceTurn = {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 100,
    endTime: 900,
    nodes: [
      { id: 'user-1', type: 'user', content: 'hi', timestamp: 100 },
      {
        id: 'a-0-text', type: 'assistant_text', content: '', timestamp: 200,
        thinking: LEAKY_THINKING,
      } as TraceTurn['nodes'][number],
      { id: 'a-final', type: 'assistant_text', content: 'final answer', timestamp: 900 } as TraceTurn['nodes'][number],
    ],
  };
  return renderToStaticMarkup(React.createElement(TurnCard, { turn, defaultExpanded: true }));
}

const FORBIDDEN = [
  'delegate_session', 'list_session_candidates', 'candidateSetId', 'MemoryRead',
  'ToolSearch', 'create_new', 'delegate_existing', 'memory_search', 'AskUserQuestion',
];

describe('TurnCard → ThinkingDigestBanner — 展开的思考不外露内部工具名', () => {
  for (const language of ['zh', 'en'] as const) {
    it(`${language}: 展开的思考文本不含内部工具名/标识符，普通句子原样保留`, () => {
      const html = renderThinking(language);
      const scroller = html.slice(html.indexOf('thinking-digest-scroller'));
      expect(scroller).toContain('thinking-digest-scroller');
      for (const word of FORBIDDEN) expect(scroller).not.toContain(word);
      expect(scroller).not.toMatch(/\bGlob\b/);
      expect(scroller).toContain(PROSE);
    });
  }
});
