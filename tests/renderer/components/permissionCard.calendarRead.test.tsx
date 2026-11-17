// ============================================================================
// 日历只读审批卡：写明读什么、哪段时间；通用卡无可列内容时不出「请确认下面的…」空指向。
// ============================================================================
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

// PermissionCard 是 store 连接型组件（无 props），mock 三个 store + ipcService
// 后用 renderToStaticMarkup 渲染（与 permissionCard.reason.test.tsx 同一模式）。
const storeState = vi.hoisted(() => ({
  request: null as ContractPermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: storeState.language === 'en' ? en : zh,
      language: storeState.language,
    }),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: storeState.request,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { currentSessionId: string | null }) => unknown) =>
    selector({ currentSessionId: null }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

const { PermissionCard } = await import('../../../src/renderer/components/PermissionDialog/PermissionCard');


function req(overrides: Partial<ContractPermissionRequest>): ContractPermissionRequest {
  return { id: 'req-cal-1', tool: 'calendar', type: 'mcp', details: {}, timestamp: 1, ...overrides };
}

function render(language: 'zh' | 'en', request: ContractPermissionRequest): string {
  storeState.language = language;
  storeState.request = request;
  return renderToStaticMarkup(React.createElement(PermissionCard));
}

const text = (html: string) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
const FROM = new Date(2026, 10, 16, 0, 0).getTime();
const TO = new Date(2026, 10, 23, 0, 0).getTime();

describe('日历只读审批卡', () => {
  it('list_events 带明确区间（zh）：标题/问句/时间范围/日历名', () => {
    const out = text(render('zh', req({ details: { action: 'list_events', from_ms: FROM, to_ms: TO, calendar: '工作' } as never })));
    expect(out).toContain('查看日程');
    expect(out).toContain('允许 Neo 查看你的日程吗？');
    expect(out).toContain('时间范围：2026/11/16 00:00 至 2026/11/23 00:00；日历：工作');
    expect(out).not.toContain('请确认下面的任务和操作范围');
  });

  it('list_events 带明确区间（en）', () => {
    const out = text(render('en', req({ details: { action: 'list_events', from_ms: FROM, to_ms: TO } as never })));
    expect(out).toContain('View your calendar');
    expect(out).toContain('Let Neo look at your calendar?');
    expect(out).toContain('Time range: 2026/11/16 00:00 to 2026/11/23 00:00; Calendar: all calendars');
    expect(out).not.toContain('Review the task and scope below');
  });

  it('list_events 无区间：默认今天起 14 天、所有日历（zh + en）', () => {
    const zh = text(render('zh', req({ details: { action: 'list_events' } as never })));
    expect(zh).toContain('时间范围：今天起未来 14 天；日历：所有日历');
    const en = text(render('en', req({ details: { action: 'list_events' } as never })));
    expect(en).toContain('Time range: today and the next 14 days; Calendar: all calendars');
  });

  it('list_calendars：范围是日历列表（zh + en）', () => {
    expect(text(render('zh', req({ details: { action: 'list_calendars' } as never })))).toContain('范围：你的日历列表');
    expect(text(render('en', req({ details: { action: 'list_calendars' } as never })))).toContain('Scope: your list of calendars');
  });

  it('calendar 的写动作仍走通用路径', () => {
    const out = text(render('zh', req({ details: { action: 'delete_event' } as never })));
    expect(out).not.toContain('查看日程');
  });

  it('通用请求没有可列内容：不出「请确认下面的…」（zh + en）', () => {
    const zh = text(render('zh', req({ tool: 'mystery_tool', type: 'command', details: {} })));
    expect(zh).toContain('需要你确认');
    expect(zh).not.toContain('请确认下面的任务和操作范围');
    const en = text(render('en', req({ tool: 'mystery_tool', type: 'command', details: {} })));
    expect(en).not.toContain('Review the task and scope below');
  });

  it('通用请求带参数预览：保留「请确认下面的…」（zh + en）', () => {
    const zh = text(render('zh', req({ tool: 'mystery_tool', type: 'command', details: {}, argsPreview: 'q=1' })));
    expect(zh).toContain('请确认下面的任务和操作范围');
    const en = text(render('en', req({ tool: 'mystery_tool', type: 'command', details: {}, argsPreview: 'q=1' })));
    expect(en).toContain('Review the task and scope below before approving.');
  });
});
