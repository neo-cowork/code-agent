// @vitest-environment jsdom
// N-FIX-ROLE-WAKE-CADENCE-NO-RECORD r1：「建议」唤醒的待过目行要把建议内容摆出来（真实收件箱组件）。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionAutomationRecord } from '../../../src/shared/contract/sessionAutomation';
import { AutomationReviewInbox } from '../../../src/renderer/components/features/cron/AutomationReviewInbox';

const rows = vi.hoisted(() => ({ value: [] as SessionAutomationRecord[] }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    listPendingReview: async () => rows.value,
    countPendingReview: async () => rows.value.length,
    listOutboundDrafts: async () => [],
    listParkedApprovals: async () => [],
  },
}));
vi.mock('../../../src/renderer/services/rolesClient', () => ({ listRoles: async () => [] }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke: vi.fn(), invokeDomain: vi.fn() } }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (select: (s: { switchSession: () => void }) => unknown) => select({ switchSession: vi.fn() }),
}));
afterEach(() => { cleanup(); rows.value = []; });

describe('role-wake suggest row in the inbox', () => {
  it('shows the suggestion summary as the row digest', async () => {
    rows.value = [{
      id: 'role_wake:s1', sourceSessionId: null, type: 'role_wake', status: 'pending_review',
      title: '周报提醒员 · 主动巡检', createdAt: 1, updatedAt: 1,
      config: {
        roleId: '周报提醒员',
        pendingReview: { resultSessionId: 's1', at: 1, digest: { artifactCount: 0, summaryLine: '第47周周报还缺下周计划', summaryText: '建议先补上下周计划再提交。' } },
      },
    }];
    render(<AutomationReviewInbox />);
    await waitFor(() => expect(screen.getByTestId('automation-review-summary').textContent).toContain('建议先补上下周计划再提交。'));
    expect(screen.getByTestId('automation-review-item').textContent).toContain('周报提醒员');
  });
});
