// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PARKED_APPROVAL_ENTRY_PATH } from '@shared/parkedApprovalLocation';
import type { CronJobDefinition } from '@shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const state = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: state.language === 'zh' ? zh : en, language: state.language }) };
});
vi.mock('../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({ accounts: [], conversationsByAccount: {} }),
}));
vi.mock('../../../src/renderer/services/rolesClient', () => ({ listRoles: vi.fn().mockResolvedValue([]) }));

import { ScheduleConfirmCard } from '../../../src/renderer/components/features/chat/ChatInput/ScheduleConfirmCard';
import { PendingRoutineRestate } from '../../../src/renderer/components/features/cron/PendingRoutineRestate';
import { SavedRoutineRestate } from '../../../src/renderer/components/features/cron/SavedRoutineRestate';

afterEach(cleanup);

const job: CronJobDefinition = {
  id: 'daily-mail', runsOn: 'local', name: 'Daily mail summary', enabled: true,
  scheduleType: 'cron', schedule: { type: 'cron', expression: '0 9 * * *' },
  action: { type: 'agent', agentType: 'default', prompt: 'Summarize new mail' },
  createdAt: 0, updatedAt: 0,
};

describe('scheduled result location i18n drift', () => {
  it('zh matches the parked reminder and live navigation labels', () => {
    expect(zh.scheduleConfirm.reviewInbox).toBe(PARKED_APPROVAL_ENTRY_PATH);
    expect(zh.scheduleConfirm.reviewInbox).toBe(`「${zh.sidebar.capabilityZone.automation}」→「${zh.cronCenter.tabRuns}」`);
  });
  it('en matches the live Automations title and Run history tab', () => {
    expect(en.scheduleConfirm.reviewInbox).toBe(`${en.cronCenter.title} → ${en.cronCenter.tabRuns}`);
  });
});

it.each(['zh', 'en'] as const)('production result rows without resultChannel (%s)', (language) => {
  state.language = language;
  const t = language === 'zh' ? zh : en;
  const confirm = render(<ScheduleConfirmCard
    draft={{ input: job, description: job.name, sourceSessionId: 'mail-session' }}
    confirming={false} onConfirm={vi.fn()} onDismiss={vi.fn()}
  />);
  const confirmRow = confirm.container.querySelector('[data-schedule-row="result"]');
  expect(confirmRow?.textContent).toBe(`${t.scheduleConfirm.result}${t.scheduleConfirm.reviewInbox}`);
  process.stdout.write(`DOM ${language} ScheduleConfirmCard result: ${confirmRow?.outerHTML}\n`);
  confirm.unmount();
  const saved = render(<SavedRoutineRestate job={job} onDone={vi.fn()} />);
  const savedRow = saved.container.querySelector('[data-saved-routine-row="result"]');
  expect(savedRow?.textContent).toBe(`${t.scheduleConfirm.result}${t.scheduleConfirm.reviewInbox}`);
  process.stdout.write(`DOM ${language} SavedRoutineRestate result: ${savedRow?.outerHTML}\n`);
  saved.unmount();
  const pending = render(<PendingRoutineRestate input={job} confirming={false} onConfirm={vi.fn()} onBack={vi.fn()} />);
  const pendingRow = pending.container.querySelector('[data-pending-routine-row="result"]');
  expect(pendingRow?.textContent).toBe(`${t.scheduleConfirm.result}${t.scheduleConfirm.reviewInbox}`);
  process.stdout.write(`DOM ${language} PendingRoutineRestate result: ${pendingRow?.outerHTML}\n`);
});
