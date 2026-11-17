// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const COMMAND = 'ls -la /Users/example/Documents/morning-notes';
const FILE_PATH = '/Users/example/Documents/morning-notes/weekly-report.md';
const FILE_NAME = 'weekly-report.md';
const OTHER_PREVIEW = 'https://example.com/inbox-notes';
const VOID_REASON = '这一步等你确认超过 24 小时，已自动作废，没有执行。';

function row(over: Partial<ParkedApprovalInboxItem>): ParkedApprovalInboxItem {
  return {
    id: 'row-1',
    sessionId: 'session-1',
    sessionTitle: 'Morning file summary',
    tool: 'Bash',
    status: 'pending',
    requestedAt: Date.now(),
    ...over,
  };
}

function outsideDisclosure(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('details').forEach((node) => node.remove());
  const titles = [...clone.querySelectorAll('[title]')].map((node) => node.getAttribute('title') ?? '');
  return `${clone.textContent ?? ''}\n${titles.join('\n')}`;
}

describe('automation inbox args stay behind the disclosure', () => {
  it.each(['zh', 'en'] as const)('voided Bash keeps the command inside View command (%s)', async (language) => {
    state.language = language;
    state.rows = [row({ status: 'voided', tool: 'Bash', argsPreview: COMMAND, voidReason: VOID_REASON })];
    render(<AutomationReviewInbox />);
    const card = await screen.findByTestId('parked-approval-voided');
    const summary = language === 'zh' ? '查看命令' : 'View command';
    expect(outsideDisclosure(card)).not.toContain(COMMAND);
    expect(outsideDisclosure(card)).not.toContain('ls -la');
    const details = screen.getByText(summary).closest('details');
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText(summary));
    expect(screen.getByTestId('parked-shell-preview').textContent).toBe(COMMAND);
    expect(screen.queryByTestId('parked-args-preview')).toBeNull();
  });

  it.each([
    ['zh', 'pending', 'Write'],
    ['en', 'pending', 'Edit'],
    ['zh', 'pending', 'Append'],
    ['en', 'pending', 'EDIT'],
    ['zh', 'voided', 'Write'],
    ['en', 'voided', 'Edit'],
    ['zh', 'voided', 'Append'],
    ['en', 'voided', 'append'],
  ] as const)('file tool %s %s %s shows only the file name outside the location disclosure', async (language, status, tool) => {
    state.language = language;
    state.rows = [row({
      status,
      tool,
      argsPreview: FILE_PATH,
      voidReason: status === 'voided' ? VOID_REASON : undefined,
    })];
    render(<AutomationReviewInbox />);
    const testId = status === 'voided' ? 'parked-approval-voided' : 'parked-approval-item';
    const card = await screen.findByTestId(testId);
    const outside = outsideDisclosure(card);
    expect(outside).toContain(FILE_NAME);
    expect(outside).not.toContain(FILE_PATH);
    expect(outside).not.toContain('/Users/example');
    expect(outside).not.toContain('morning-notes');
    const label = language === 'zh' ? '操作内容：' : 'Details: ';
    expect(screen.getByTestId('parked-args-preview').textContent).toBe(`${label}${FILE_NAME}`);
    const summary = language === 'zh' ? '查看完整位置' : 'View full location';
    const details = screen.getByText(summary).closest('details');
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText(summary));
    expect(screen.getByTestId('parked-file-location').textContent).toBe(FILE_PATH);
  });

  it.each(['zh', 'en'] as const)('a non-shell non-file tool keeps its preview line (%s)', async (language) => {
    state.language = language;
    state.rows = [
      row({ id: 'pending-other', tool: 'WebFetch', argsPreview: OTHER_PREVIEW }),
      row({ id: 'voided-other', status: 'voided', tool: 'WebFetch', argsPreview: OTHER_PREVIEW, voidReason: VOID_REASON }),
    ];
    render(<AutomationReviewInbox />);
    await waitFor(() => expect(screen.getAllByTestId('parked-args-preview')).toHaveLength(2));
    const label = language === 'zh' ? '操作内容：' : 'Details: ';
    for (const node of screen.getAllByTestId('parked-args-preview')) {
      expect(node.textContent).toBe(`${label}${OTHER_PREVIEW}`);
    }
    expect(screen.queryByTestId('parked-shell-preview')).toBeNull();
    expect(screen.queryByTestId('parked-file-location')).toBeNull();
    expect(document.querySelector('details')).toBeNull();
  });
});
