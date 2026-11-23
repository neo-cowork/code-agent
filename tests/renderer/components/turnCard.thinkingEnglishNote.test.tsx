// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  getRunningToolStartTime: () => undefined,
  getRunningSubagentCount: () => 0,
  getStreamingWaitingReason: () => undefined,
}));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));
vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

afterEach(() => {
  cleanup();
  i18nState.language = 'zh';
});

const baseTime = 1_800_000_000_000;
const ENGLISH = 'The user wants a summary of meeting notes. I should read notes.txt first, then open neo://thread/new and [go](neo://thread/new).';

function turn(reasoning: string, status: TraceTurn['status'] = 'completed'): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status,
    startTime: baseTime - 1_000,
    endTime: status === 'completed' ? baseTime + 5_000 : undefined,
    nodes: [
      { id: 'user-1', type: 'user', content: '整理会议记录', timestamp: baseTime - 1_000 },
      { id: 'r-1', type: 'assistant_text', content: status === 'completed' ? '好的' : '', timestamp: baseTime, reasoning } as TraceTurn['nodes'][number],
    ],
  };
}

const toggle = () => screen.getByTestId('thinking-digest').querySelector('button') as HTMLButtonElement;
const content = () => screen.getByTestId('thinking-digest').querySelector('.thinking-digest-content') as HTMLElement;

describe('思考横幅：英文推理在中文界面折叠为一句中文', () => {
  it('zh + 英文推理：收起行是固定中文句，不含英文推理词；展开显示原文', () => {
    render(<TurnCard turn={turn(ENGLISH)} />);
    expect(toggle().textContent).toBe('思考 5s · 推理原文为英文，点开可看');
    expect(toggle().textContent).not.toMatch(/[A-Za-z]{3,}/);
    fireEvent.click(toggle());
    expect(content().textContent).toContain('The user wants a summary of meeting notes.');
  });

  it('展开原文里的 neo:// 是纯文本，没有 <a>/href', () => {
    render(<TurnCard turn={turn(ENGLISH)} />);
    fireEvent.click(toggle());
    expect(content().textContent).toContain('neo://thread/new');
    expect(content().textContent).toContain('[go](neo://thread/new)');
    expect(content().querySelector('a')).toBeNull();
    expect(content().querySelector('[href]')).toBeNull();
  });

  it('zh + 中文推理：保持「思考 5s · 1 段」', () => {
    render(<TurnCard turn={turn('先读取会议记录，再整理成三条要点。')} />);
    expect(toggle().textContent).toBe('思考 5s · 1 段');
  });

  it('en 界面 + 英文推理：保持 Thought for', () => {
    i18nState.language = 'en';
    render(<TurnCard turn={turn(ENGLISH)} />);
    expect(toggle().textContent).toBe('Thought for 5s · 1 segment');
  });

  it('流式（有活动段）仍显示「正在思考…」', () => {
    render(<TurnCard turn={turn(ENGLISH, 'streaming')} />);
    expect(toggle().textContent).toContain('正在思考…');
  });
});
