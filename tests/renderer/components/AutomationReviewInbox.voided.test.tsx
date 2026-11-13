// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParkedApprovalInboxItem } from '../../../src/shared/contract/pendingApproval';
import { AutomationReviewInbox } from '../../../src/renderer/components/features/cron/AutomationReviewInbox';

const state = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en', rows: [] as ParkedApprovalInboxItem[] }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh, en } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ t: state.language === 'zh' ? zh : en, language: state.language }) };
});
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    listPendingReview: async () => [],
    countPendingReview: async () => 0,
    listParkedApprovals: async () => state.rows,
  },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke: vi.fn() } }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (select: (s: { switchSession: () => void }) => unknown) => select({ switchSession: vi.fn() }),
}));
afterEach(() => { cleanup(); state.language = 'zh'; state.rows = []; });

function row(title: string, id = title): ParkedApprovalInboxItem {
  return { id, sessionId: 'session-1', tool: title, displayTool: title, status: 'voided', requestedAt: Date.now(),
    voidReason: '这一步等你确认超过 24 小时，已自动作废，没有执行。' };
}
const names = ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'ListDirectory', 'WebFetch', 'WebSearch', 'mail_send', 'mcp__private__operation'];

describe('voided approval history through the real inbox', () => {
  it.each(['zh', 'en'] as const)('11 rows collapsed, expand and collapse, pending stays visible (%s)', async (language) => {
    state.language = language;
    state.rows = [
      ...names.map((name) => row(`重启前发起 · ${name}`)),
      { ...row('每周报告确认'), id: 'pending', status: 'pending' },
    ];
    render(<AutomationReviewInbox />);
    await waitFor(() => expect(screen.getAllByTestId('parked-approval-voided-summary')).toHaveLength(1));
    expect(screen.queryAllByTestId('parked-approval-voided')).toHaveLength(0);
    expect(screen.getAllByTestId('parked-approval-item')).toHaveLength(1);
    const summary = screen.getByTestId('parked-approval-voided-summary');
    expect(summary.textContent).toContain(language === 'zh' ? '11 条已作废的审批，没有执行' : '11 approvals were voided and did not run');
    const toggle = screen.getByTestId('parked-approval-voided-toggle');
    expect(toggle.textContent).toBe(language === 'zh' ? '展开' : 'Expand');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe(language === 'zh' ? '收起' : 'Collapse');
    const expanded = screen.getAllByTestId('parked-approval-voided');
    expect(expanded).toHaveLength(11);
    expect(expanded[0].textContent).toContain(language === 'zh' ? '重启前发起 · 运行命令' : 'Started before restart · Run a command');
    expect(expanded[10].textContent).toContain(language === 'zh' ? '一项操作' : 'An action');
    for (const item of expanded) {
      expect(item.textContent).not.toMatch(/Bash|mcp__/);
      if (language === 'en') expect(item.textContent).not.toMatch(/[\u3400-\u9fff]/u);
      else expect(item.textContent).not.toMatch(/[A-Za-z]/);
    }
    expect(screen.getByTestId('parked-approval-item').compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryAllByTestId('parked-approval-voided')).toHaveLength(0);
    expect(screen.getAllByTestId('parked-approval-item')).toHaveLength(1);
  });

  it.each([
    ['bAsH', '运行命令'], ['WRITE', '写入文件'], ['Edit', '编辑文件'], ['Read', '读取文件'],
    ['Glob', '查找文件'], ['Grep', '搜索内容'], ['ListDirectory', '查看目录'],
    ['WebFetch', '读取网页'], ['WebSearch', '搜索网页'], ['mail_send', '发送邮件'],
    ['mail_draft', '起草邮件'], ['mail', '邮件操作'], ['mcp__plugin__send', '一项操作'],
    ['UnrecognizedTool', '一项操作'], ['目录访问：项目资料', '目录访问：项目资料'],
    ['Read the weekly report', 'Read the weekly report'],
  ])('single row is not folded and presents %s', async (title, expected) => {
    state.rows = [row(title)];
    render(<AutomationReviewInbox />);
    await waitFor(() => expect(screen.getByTestId('parked-approval-voided')).toBeTruthy());
    expect(screen.getByTestId('parked-approval-voided').firstElementChild?.textContent).toBe(expected);
    expect(screen.queryByTestId('parked-approval-voided-summary')).toBeNull();
    expect(screen.queryByTestId('parked-approval-voided-toggle')).toBeNull();
  });
});


describe('non-voided task names through the production inbox', () => {
  it.each(['zh', 'en'] as const)('two pending Write tasks, orphaned and sensitive-step cards show distinct names; old and pairing rows have no blank line (%s)', async (language) => {
    state.language = language;
    const pending = (id: string, sessionTitle?: string): ParkedApprovalInboxItem => ({
      id, sessionId: id, sessionTitle, tool: 'Write', displayTool: 'Write', status: 'pending', requestedAt: Date.now(),
    });
    state.rows = [
      pending('weekly', 'Weekly report'), pending('invoices', 'Sort invoices'),
      { ...pending('orphaned', 'Client receipts'), status: 'orphaned' },
      { ...pending('sensitive', 'Pay supplier'), sensitiveStep: { kind: 'payment', appName: 'Billing', elementLabel: 'Confirm' } },
      pending('old'), { ...pending('pairing', 'Must not display'), sessionId: null, kind: 'channel_pairing' },
    ];
    render(<AutomationReviewInbox />);
    await waitFor(() => expect(screen.getAllByTestId('parked-approval-item')).toHaveLength(6));
    const cards = screen.getAllByTestId('parked-approval-item');
    expect(screen.getAllByTestId('parked-session-title').map((el) => el.textContent)).toEqual([
      'Weekly report', 'Sort invoices', 'Client receipts', 'Pay supplier',
    ]);
    for (const [index, name] of ['Weekly report', 'Sort invoices', 'Client receipts', 'Pay supplier'].entries()) {
      const line = within(cards[index]).getByTestId('parked-session-title');
      expect(line.textContent).toBe(name);
      expect(line.className).toBe('truncate text-xs text-zinc-400');
      expect(line.previousElementSibling?.textContent).toBe('Write');
    }
    expect(within(cards[3]).getByTestId('sensitive-step-parked-row')).toBeTruthy();
    expect(cards[2].className).toContain('opacity-50');
    for (const card of cards.slice(4)) {
      expect(within(card).queryByTestId('parked-session-title')).toBeNull();
      expect(Array.from(card.querySelectorAll('div')).some((el) => el.childElementCount === 0 && !el.textContent?.trim())).toBe(false);
    }
    if (language === 'en') expect(screen.getByTestId('parked-approval-group').textContent).not.toMatch(/[\u3400-\u9fff]|\[Scheduled\]/u);
  });
});
