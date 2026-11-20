// @vitest-environment jsdom
// ============================================================================
// N-FIX-APPROVAL-CARD-NOTES-ROW-NO-LABEL —— 写回审批卡查看态备注行带字段名
//   日历/提醒的 notes 原来是无标签的裸多行文本（FB-1704）；现在与其他字段一样
//   走「标签｜值」行（zh 备注 / en Notes）。mail_send 正文维持无标签分隔线样式。
//   经 PermissionCard → RequestDetails → WritebackFieldsView 真卡路径挂载。
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: state.language === 'en' ? en : zh, language: state.language }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: 'session-current',
    setPendingPermissionRequest: vi.fn(),
    language: state.language,
    setLanguage: () => {},
    cloudUIStrings: undefined,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

const localMs = (hour: number, minute = 0) => new Date(2026, 7, 26, hour, minute).getTime();

function nativeRequest(id: string, tool: string, details: Record<string, unknown>, connectorName: string): PermissionRequest {
  return {
    id,
    sessionId: 'request-session',
    tool,
    type: 'file_write',
    forceConfirm: true,
    details: details as PermissionRequest['details'],
    boundary: { id: 'connector.external_write', connectorName },
    timestamp: 1,
  };
}

/** writeback-view-content 是 CollapsibleBody 里的 <pre>；祖父级是「标签｜值」行或无标签分隔块。 */
const bodyBlock = () => screen.getByTestId('writeback-view-content').parentElement!.parentElement!;
const bodyRow = () => bodyBlock().parentElement!;

describe('审批卡查看态备注行带字段名', () => {
  beforeEach(() => {
    state.language = 'zh';
  });
  afterEach(() => {
    cleanup();
    if (state.request) releaseApprovalResponse(state.request.id);
    state.request = null;
  });

  it.each([
    ['zh', '备注', '带上季度报表'],
    ['en', 'Notes', 'bring the quarterly report'],
  ] as const)('%s：calendar_create_event 的 notes 行带「%s」标签，与标题行同款', (language, label, note) => {
    state.language = language;
    state.request = nativeRequest(`notes-calendar-${language}`, 'calendar_create_event', {
      calendar: 'Work', title: 'Quarterly review', start_ms: localMs(15), end_ms: localMs(16), notes: note,
    }, '日历');
    render(<PermissionCard />);
    const row = bodyRow();
    expect(within(row).getByText(label)).toBeTruthy();
    expect(within(row).getByTestId('writeback-view-content').textContent).toBe(note);
    expect(row.className).toContain('flex');
    // 标签文本与编辑态同一把 i18n 钥匙（fieldNotes）
    const t = language === 'en' ? en : zh;
    expect(within(row).getByText(label).textContent).toBe(t.decisionCard.permission.writeback.fieldNotes);
  });

  it.each([
    ['zh', '备注'],
    ['en', 'Notes'],
  ] as const)('%s：reminders_create 的 notes 行带「%s」标签', (language, label) => {
    state.language = language;
    state.request = nativeRequest(`notes-reminder-${language}`, 'reminders_create', {
      list: 'Personal', title: 'submit minutes', notes: 'attach action items', remind_at_ms: localMs(15),
    }, '提醒事项');
    render(<PermissionCard />);
    expect(within(bodyRow()).getByText(label)).toBeTruthy();
  });

  it('reminders_update 的 notes 行同样带标签（同一条字段表路径）', () => {
    state.request = nativeRequest('notes-reminder-update', 'reminders_update', {
      list: 'Personal', reminder_id: 'opaque-1', title: 'submit minutes', notes: '补上负责人',
    }, '提醒事项');
    render(<PermissionCard />);
    expect(within(bodyRow()).getByText('备注')).toBeTruthy();
  });

  it.each([
    ['缺省 notes', { list: 'Personal', title: 'submit minutes' }],
    ['空串 notes', { list: 'Personal', title: 'submit minutes', notes: '' }],
  ] as const)('%s：整行不渲染，不出孤标签', (_caseName, details) => {
    state.request = nativeRequest(`notes-empty-${_caseName === '空串 notes' ? 'blank' : 'missing'}`, 'reminders_create', details, '提醒事项');
    render(<PermissionCard />);
    expect(screen.queryByTestId('writeback-view-content')).toBeNull();
    expect(screen.getByTestId('writeback-fields-view').textContent).not.toContain('备注');
  });

  it('mail_send 正文仍是分隔线下的无标签块', () => {
    state.request = nativeRequest('notes-mail', 'mail_send', {
      to: ['li.wei@acme.com'], subject: 'Q3 对账单', content: '李伟你好，请查收附件。',
    }, '邮件');
    render(<PermissionCard />);
    expect(screen.getByTestId('writeback-view-content').textContent).toContain('请查收附件');
    expect(bodyBlock().className).toContain('border-t');
    const view = screen.getByTestId('writeback-fields-view');
    expect(within(view).queryByText('正文')).toBeNull();
  });

  it('备注行保留折叠行为：超过 12 行先收起，点开后出全文', () => {
    const longNote = Array.from({ length: 14 }, (_, i) => `note line ${i + 1}`).join('\n');
    state.request = nativeRequest('notes-long', 'calendar_create_event', {
      calendar: 'Work', title: 'review', start_ms: localMs(15), notes: longNote,
    }, '日历');
    render(<PermissionCard />);
    const row = bodyRow();
    expect(within(row).getByText('备注')).toBeTruthy();
    const content = within(row).getByTestId('writeback-view-content');
    expect(content.textContent).toContain('note line 12');
    expect(content.textContent).not.toContain('note line 13');
    fireEvent.click(within(row).getByRole('button', { name: '展开全文' }));
    expect(within(row).getByTestId('writeback-view-content').textContent).toContain('note line 14');
    fireEvent.click(within(row).getByRole('button', { name: '收起' }));
    expect(within(row).getByTestId('writeback-view-content').textContent).not.toContain('note line 13');
  });
});
