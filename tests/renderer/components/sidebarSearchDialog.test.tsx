// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { SidebarSearchDialog } from '../../../src/renderer/components/features/sidebar/SidebarSearchDialog';
import { formatLocalDateTime } from '../../../src/renderer/utils/i18nTime';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh }, { en }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return {
    useI18n: () => ({ t: i18nState.language === 'zh' ? zh : en, language: i18nState.language }),
  };
});

const sessions = [
  {
    id: 'session-message-hit',
    title: '不相关标题',
    modelConfig: { provider: 'openai', model: 'gpt-5.4' },
    createdAt: 100,
    updatedAt: 200,
    status: 'idle',
    messageCount: 3,
    turnCount: 2,
  },
  {
    id: 'session-recent',
    title: '最近任务',
    modelConfig: { provider: 'openai', model: 'gpt-5.4' },
    createdAt: 50,
    updatedAt: 150,
    status: 'idle',
    messageCount: 1,
    turnCount: 1,
  },
] as SessionWithMeta[];

const messageHits = {
  'session-message-hit': {
    sessionId: 'session-message-hit',
    bestHit: {
      sessionId: 'session-message-hit',
      messageId: 'message-1',
      snippet: '正文里的关键字',
      messagePositionLabel: '第 2 轮',
      role: 'user' as const,
      timestamp: 190,
      matchCount: 1,
      relevance: 0.9,
    },
    hits: [],
    totalHitCount: 4,
  },
};

afterEach(() => {
  i18nState.language = 'zh';
  cleanup();
});

describe('SidebarSearchDialog', () => {
  it('shows message-hit counts and moves the search scope controls into the dialog', () => {
    render(
      <SidebarSearchDialog
        isOpen
        query="关键字"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
        currentSessionId={null}
        messageSearchHitsBySessionId={messageHits}
        messageSearchLoading={false}
        effectiveSearchScope="current-project"
        setSearchScope={vi.fn()}
        canSearchCurrentProject
        onSelectSession={vi.fn()}
      />,
    );

    expect(screen.queryByText('不相关标题')).not.toBeNull();
    expect(screen.queryByText('命中 4 条消息')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '当前项目' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '全部' })).not.toBeNull();
    expect(
      screen.getByRole('textbox', { name: '搜索会话标题与消息内容' }).getAttribute('type'),
    ).toBe('text');
    expect(screen.getByRole('textbox', { name: '搜索会话标题与消息内容' }).parentElement?.querySelector('svg')?.classList.contains('h-4')).toBe(true);
    expect(screen.getByRole('textbox', { name: '搜索会话标题与消息内容' }).parentElement?.querySelector('svg')?.classList.contains('w-4')).toBe(true);
  });

  it('shows distinct local update times for same-title rows in zh and en without leaking internal identifiers', () => {
    const year = new Date().getFullYear();
    const timestamps = [
      new Date(year, 10, 8, 15, 3).getTime(),
      new Date(year, 10, 8, 13, 45).getTime(),
      new Date(year, 10, 7, 21, 10).getTime(),
      new Date(year, 10, 6, 9, 5).getTime(),
    ];
    const sameTitleSessions = timestamps.map((updatedAt, index) => ({
      ...sessions[0],
      id: `same-title-${index}`,
      title: '[Schedule] 停车A-无目录',
      updatedAt,
    }));
    const view = render(
      <SidebarSearchDialog
        isOpen
        query="停车A"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        sessions={sameTitleSessions}
        currentSessionId={null}
        messageSearchHitsBySessionId={{}}
        messageSearchLoading={false}
        effectiveSearchScope="all"
        setSearchScope={vi.fn()}
        canSearchCurrentProject
        onSelectSession={vi.fn()}
      />,
    );

    const zhRows = screen.getAllByRole('option');
    const zhTimes = zhRows.map((row) => row.querySelector('[data-testid="sidebar-search-session-time"]')?.textContent);
    expect(zhTimes).toEqual(timestamps.map((timestamp) => formatLocalDateTime(timestamp, 'zh')));
    expect(new Set(zhTimes).size).toBe(4);
    expect(zhRows.map((row) => row.textContent).join(' ')).not.toMatch(/session_|[0-9a-f]{8}-[0-9a-f-]{27,}|\/(?:Users|tmp|repo)\//i);

    i18nState.language = 'en';
    view.rerender(
      <SidebarSearchDialog
        isOpen
        query="停车A"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        sessions={sameTitleSessions}
        currentSessionId={null}
        messageSearchHitsBySessionId={{}}
        messageSearchLoading={false}
        effectiveSearchScope="all"
        setSearchScope={vi.fn()}
        canSearchCurrentProject
        onSelectSession={vi.fn()}
      />,
    );
    const enRows = screen.getAllByRole('option');
    expect(enRows.map((row) => row.querySelector('[data-testid="sidebar-search-session-time"]')?.textContent)).toEqual(
      timestamps.map((timestamp) => formatLocalDateTime(timestamp, 'en')),
    );
  });

  it('selects a session and conditionally removes the dialog from the DOM', async () => {
    const onSelect = vi.fn();
    const Harness = () => {
      const [open, setOpen] = useState(true);
      return (
        <SidebarSearchDialog
          isOpen={open}
          query=""
          onQueryChange={vi.fn()}
          onClose={() => setOpen(false)}
          sessions={sessions}
          currentSessionId={null}
          messageSearchHitsBySessionId={{}}
          messageSearchLoading={false}
          effectiveSearchScope="all"
          setSearchScope={vi.fn()}
          canSearchCurrentProject
          onSelectSession={(sessionId) => {
            onSelect(sessionId);
            setOpen(false);
          }}
        />
      );
    };

    render(<Harness />);
    fireEvent.click(screen.getByRole('option', { name: /最近任务/ }));

    expect(onSelect).toHaveBeenCalledWith('session-recent');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('supports arrow-key selection and Enter navigation', () => {
    const onSelect = vi.fn();
    render(
      <SidebarSearchDialog
        isOpen
        query=""
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
        currentSessionId={null}
        messageSearchHitsBySessionId={{}}
        messageSearchLoading={false}
        effectiveSearchScope="all"
        setSearchScope={vi.fn()}
        canSearchCurrentProject
        onSelectSession={onSelect}
      />,
    );

    const input = screen.getByRole('textbox', { name: '搜索会话标题与消息内容' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('session-recent');
  });
  describe('same-title same-minute collisions', () => {
    const year = new Date().getFullYear();
    const at = (h: number, m: number, sec: number) => new Date(year, 10, 8, h, m, sec).getTime();
    const mk = (id: string, title: string, updatedAt: number) =>
      ({ ...sessions[0], id, title, createdAt: updatedAt - 1000, updatedAt }) as SessionWithMeta;
    const renderRows = (list: SessionWithMeta[], currentSessionId: string | null = null) =>
      render(
        <SidebarSearchDialog
          isOpen
          query="停车"
          onQueryChange={vi.fn()}
          onClose={vi.fn()}
          sessions={list}
          currentSessionId={currentSessionId}
          messageSearchHitsBySessionId={{}}
          messageSearchLoading={false}
          effectiveSearchScope="all"
          setSearchScope={vi.fn()}
          canSearchCurrentProject
          onSelectSession={vi.fn()}
        />,
      );
    const timeOf = (row: HTMLElement) =>
      row.querySelector('[data-testid="sidebar-search-session-time"]')?.textContent;

    it('shows seconds on colliding rows and tags only the newest as latest (zh)', () => {
      const list = [
        mk('a', '[Schedule] 停车', at(16, 1, 42)),
        mk('b', '[Schedule] 停车', at(16, 1, 7)),
        mk('c', '其他任务', at(16, 1, 30)),
        mk('d', '[Schedule] 停车', at(9, 5, 1)),
      ];
      renderRows(list);
      const rows = screen.getAllByRole('option');
      expect(timeOf(rows[0])).toMatch(/16:01:42$/);
      expect(timeOf(rows[1])).toMatch(/16:01:07$/);
      expect(rows[0].textContent).toContain('最新');
      expect(rows[1].textContent).not.toContain('最新');
      // 非碰撞行保持原样
      expect(timeOf(rows[2])).toBe(formatLocalDateTime(list[2].updatedAt, 'zh'));
      expect(timeOf(rows[3])).toBe(formatLocalDateTime(list[3].updatedAt, 'zh'));
      expect(rows[2].textContent).not.toContain('最新');
      expect(rows[3].textContent).not.toContain('最新');
    });

    it('handles a 3-row collision in en and lets a row carry both tags', () => {
      i18nState.language = 'en';
      const list = [
        mk('a', 'Daily', at(16, 1, 50)),
        mk('b', 'Daily', at(16, 1, 20)),
        mk('c', 'Daily', at(16, 1, 5)),
      ];
      renderRows(list, 'a');
      const rows = screen.getAllByRole('option');
      expect(rows.map(timeOf).map((t) => /:(\d{2}) ?(AM|PM)?$/.exec(t ?? '')?.[1])).toEqual(['50', '20', '05']);
      expect(rows.map((r) => r.textContent?.includes('Latest'))).toEqual([true, false, false]);
      expect(rows[0].textContent).toContain('Current');
    });

    it('leaves rows untouched when titles or minutes differ', () => {
      const list = [mk('a', 'Daily', at(16, 1, 50)), mk('b', 'Daily', at(16, 2, 5))];
      renderRows(list);
      const rows = screen.getAllByRole('option');
      expect(rows.map(timeOf)).toEqual(list.map((s) => formatLocalDateTime(s.updatedAt, 'zh')));
      expect(rows.some((r) => r.textContent?.includes('最新'))).toBe(false);
    });
  });

  it.each(['zh', 'en'] as const)('shows the failed copy, not the no-signal copy, when the search failed (%s)', async (language) => {
    i18nState.language = language;
    const { zh } = await import('../../../src/renderer/i18n/zh');
    const { en } = await import('../../../src/renderer/i18n/en');
    const copy = language === 'zh' ? zh.sidebar : en.sidebar;
    const base = {
      isOpen: true,
      query: 'whatever',
      onQueryChange: vi.fn(),
      onClose: vi.fn(),
      sessions: [] as SessionWithMeta[],
      currentSessionId: null,
      messageSearchHitsBySessionId: {},
      messageSearchLoading: false,
      effectiveSearchScope: 'all' as const,
      setSearchScope: vi.fn(),
      canSearchCurrentProject: false,
      onSelectSession: vi.fn(),
    };
    const { rerender } = render(<SidebarSearchDialog {...base} messageSearchFailed />);
    expect(screen.queryByText(copy.searchFailed)).not.toBeNull();
    expect(screen.queryByText(copy.noMatchedSessions)).toBeNull();

    rerender(<SidebarSearchDialog {...base} messageSearchFailed={false} />);
    expect(screen.queryByText(copy.noMatchedSessions)).not.toBeNull();
    expect(screen.queryByText(copy.searchFailed)).toBeNull();
  });
});
