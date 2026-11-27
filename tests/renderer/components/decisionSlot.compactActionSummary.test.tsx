// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Message, PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

// N-FIX-APPROVAL-BAR-COLLAPSED-HIDES-ACTION-REDO：「提醒 + 邮件草稿 + 日程」三张审批同时排队，
// 走 DecisionSlot 逐张确认。请求形状取自宿主真实广播（e2e approval-compact-action-summary 里
// /api/events 旁听到的 permission_request 原文，只把 id / timestamp 换成固定值）：
// 连接器写回一律 type=file_write + forceConfirm，details = 归一后的工具参数 + 确认门预览。

const HOST_REASON = {
  reminders: '要在外部系统里写入（提醒事项：创建提醒事项），需要你确认',
  mail: '要在外部系统里写入（邮件：保存邮件草稿），需要你确认',
  calendar: '要在外部系统里写入（日历：创建日程），需要你确认',
};

const reminderRequest: PermissionRequest = {
  id: 'perm-walkthrough-reminder',
  sessionId: 'global',
  forceConfirm: true,
  type: 'file_write',
  tool: 'reminders_create',
  details: {
    list: '提醒事项',
    title: '提交周报',
    remind_at_ms: 1795888800000,
    targetKind: 'unknown',
    grantEligible: false,
    preview: { type: 'generic', summary: '创建提醒', diff: '创建提醒\nList: 提醒事项\nTitle: 提交周报\nRemind At: 2026/11/28 10:00:00' },
  } as PermissionRequest['details'],
  reason: HOST_REASON.reminders,
  timestamp: 1795815631040,
};

const mailDraftRequest: PermissionRequest = {
  id: 'perm-walkthrough-mail-draft',
  sessionId: 'global',
  forceConfirm: true,
  type: 'file_write',
  tool: 'mail_draft',
  details: {
    to: ['alice@example.com'],
    subject: '本周进度同步',
    content: '附件是本周进度',
    targetKind: 'unknown',
    grantEligible: false,
    preview: { type: 'generic', summary: '创建邮件草稿：本周进度同步', diff: '创建邮件草稿：本周进度同步\nTo: alice@example.com' },
  } as PermissionRequest['details'],
  reason: HOST_REASON.mail,
  timestamp: 1795815631764,
};

const calendarRequest: PermissionRequest = {
  id: 'perm-walkthrough-calendar',
  sessionId: 'global',
  forceConfirm: true,
  type: 'file_write',
  tool: 'calendar_create_event',
  details: {
    calendar: '工作',
    title: '产品评审',
    start_ms: 1795906800000,
    end_ms: 1795910400000,
    targetKind: 'unknown',
    grantEligible: false,
    preview: { type: 'generic', summary: '创建日历事件', diff: '创建日历事件\nCalendar: 工作\nTitle: 产品评审\nStart: 2026/11/28 15:00:00\nEnd: 2026/11/28 16:00:00' },
  } as PermissionRequest['details'],
  reason: HOST_REASON.calendar,
  timestamp: 1795815632326,
};

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
const storeState = vi.hoisted(() => ({
  pendingPermissionRequest: null as PermissionRequest | null,
  pendingPermissionSessionId: null as string | null,
  queuedPermissionRequests: {} as Record<string, PermissionRequest[]>,
  setPendingPermissionRequest: vi.fn(),
  recordPermissionDecision: vi.fn(),
}));
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: i18nState.language === 'en' ? en : zh, language: i18nState.language }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState),
    { getState: () => storeState },
  ),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: { currentSessionId: string | null; messages: Message[]; sessions: never[] }) => unknown) => (
      selector({ currentSessionId: 'session-current', messages: [], sessions: [] })
    ),
    { getState: () => ({ currentSessionId: 'session-current', messages: [], sessions: [] }) },
  ),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
// 代理行成员数据会顺带读一次 swarm 账本（与审批无关），不计入审批 invoke 的调用断言
const approvalInvoke = vi.hoisted(() => (channel: string, ...args: unknown[]) => (
  channel === 'swarm:list-trace-runs' ? Promise.resolve([]) : invoke(channel, ...args)
));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: approvalInvoke },
  ipcService: { invoke: approvalInvoke, on: () => () => {} },
}));

import { DecisionSlot } from '../../../src/renderer/components/features/chat/DecisionSlot';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

const COPY = {
  zh: {
    cards: [
      { request: reminderRequest, question: '新建提醒「提交周报」？', remaining: '还有 2 项', approve: /^创建\s*y?$/u, viewMode: 'expanded' },
      { request: calendarRequest, question: '创建日历事件「产品评审」？', remaining: '还有 1 项', approve: /^创建\s*y?$/u, viewMode: 'expanded' },
      { request: mailDraftRequest, question: '保存邮件草稿「本周进度同步」？', remaining: null, approve: /^允许$/u, viewMode: 'compact' },
    ],
    anyRemaining: /还有 \d+ 项/u,
    detailsToggle: '更多选项与详情',
  },
  en: {
    cards: [
      { request: reminderRequest, question: 'Create reminder “提交周报”?', remaining: '2 more', approve: /^Create\s*y?$/u, viewMode: 'expanded' },
      { request: calendarRequest, question: 'Create calendar event “产品评审”?', remaining: '1 more', approve: /^Create\s*y?$/u, viewMode: 'expanded' },
      { request: mailDraftRequest, question: 'Save an email draft “本周进度同步”?', remaining: null, approve: /^Allow$/u, viewMode: 'compact' },
    ],
    anyRemaining: /\b\d+ more\b/u,
    detailsToggle: 'More options & details',
  },
} as const;

const CONTENT_FREE = [
  '允许这次操作？', '允许进行以下操作？', '新建这个提醒？', '创建这个日历事件？',
  'Allow this operation?', 'Allow the following operation?', 'Create this reminder?', 'Create this calendar event?',
];

describe('DecisionSlot · 多步任务审批逐张说清动作与对象', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.pendingPermissionRequest = null;
    storeState.pendingPermissionSessionId = null;
    storeState.queuedPermissionRequests = {};
  });

  afterEach(() => {
    cleanup();
    i18nState.language = 'zh';
    for (const request of [reminderRequest, mailDraftRequest, calendarRequest]) {
      releaseApprovalResponse(request.id);
    }
  });

  it.each(['zh', 'en'] as const)('提醒 → 日程 → 邮件草稿：每张卡默认形态都有一句话动作+对象与剩余计数（%s）', async (language) => {
    i18nState.language = language;
    const copy = COPY[language];
    // 到达顺序：提醒（成为 pending）、邮件草稿、日程（global 队列）；可编辑写回卡优先展示。
    storeState.pendingPermissionRequest = reminderRequest;
    storeState.queuedPermissionRequests = { global: [mailDraftRequest, calendarRequest] };
    const { rerender } = render(<DecisionSlot />);

    const remainingQueue = [mailDraftRequest, calendarRequest];
    for (const expected of copy.cards) {
      const card = screen.getByTestId('permission-card');
      const text = card.textContent ?? '';
      expect(text).toContain(expected.question);
      if (expected.remaining) expect(text).toContain(expected.remaining);
      else expect(text).not.toMatch(copy.anyRemaining);
      for (const sentence of CONTENT_FREE) expect(text).not.toContain(sentence);
      for (const tool of ['reminders_create', 'mail_draft', 'calendar_create_event']) expect(text).not.toContain(tool);
      expect(card.querySelector('[data-view-mode]')?.getAttribute('data-view-mode')).toBe(expected.viewMode);
      if (expected.viewMode === 'compact') {
        expect(screen.getByRole('button', { name: copy.detailsToggle }).getAttribute('aria-expanded')).toBe('false');
      }

      fireEvent.click(screen.getByRole('button', { name: expected.approve }));
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(
          IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
          expected.request.id,
          'allow',
          'global',
        );
        expect(storeState.recordPermissionDecision).toHaveBeenCalledWith(expected.request, 'once', null);
      });

      // 宿主裁决后 store 收走这张卡（buildPermissionDecisionState 的同等效果），下一张顶上来。
      act(() => {
        if (storeState.pendingPermissionRequest?.id === expected.request.id) storeState.pendingPermissionRequest = null;
        const index = remainingQueue.findIndex((request) => request.id === expected.request.id);
        if (index >= 0) remainingQueue.splice(index, 1);
        storeState.queuedPermissionRequests = remainingQueue.length > 0 ? { global: [...remainingQueue] } : {};
      });
      rerender(<DecisionSlot />);
    }

    expect(screen.queryByTestId('permission-card')).toBeNull();
  });
});
