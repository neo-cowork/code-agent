// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronJobExecution } from '@shared/contract/cron';
import { ScheduleConfirmCard } from '../../../src/renderer/components/features/chat/ChatInput/ScheduleConfirmCard';
import { buildScheduleConfirmRows } from '../../../src/renderer/components/features/chat/ChatInput/scheduleConfirm';
import type { PendingScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraft';
import { PendingRoutineRestate } from '../../../src/renderer/components/features/cron/PendingRoutineRestate';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const { getRecentExecutions } = vi.hoisted(() => ({ getRecentExecutions: vi.fn() }));
vi.mock('../../../src/renderer/services/cronClient', () => ({ cronClient: { getRecentExecutions } }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});
vi.mock('../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({ accounts: [], conversationsByAccount: {} }),
}));

const twoMinutes = { type: 'every', interval: 2, unit: 'minutes' } as const;
const hourly = { type: 'every', interval: 1, unit: 'hours' } as const;
const daily = { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' } as const;
const irregular = { type: 'cron', expression: '0,5 9 * * *' } as const;
const shell = { type: 'shell', command: 'backup.sh' } as const;
const event = { type: 'event', source: 'channel', eventName: 'message', accountId: 'acct' } as const;
const at = { type: 'at', datetime: '2030-01-01T09:00:00Z' } as const;
const noop = () => undefined;

function draft(
  schedule: CronJobDefinition['schedule'],
  options: Partial<PendingScheduleDraft['input']> = {},
): PendingScheduleDraft {
  return {
    description: 'Check whether the page changed',
    sourceSessionId: 'session',
    input: {
      name: 'Watch page',
      enabled: true,
      scheduleType: schedule.type,
      schedule,
      action: { type: 'agent', agentType: 'default', prompt: 'Check whether the page changed' },
      ...options,
    },
  };
}

function execution(id: string, overrides: Partial<CronJobExecution>): CronJobExecution {
  return { id, jobId: 'job', sessionId: 'run', status: 'completed', scheduledAt: 0, retryAttempt: 0, ...overrides };
}

const paidHistory = [
  execution('high', { cost: 0.4 }),
  execution('low', { cost: 0.1 }),
  execution('mid', { cost: 0.2, runsOn: 'local' }),
  execution('cloud', { cost: 4, runsOn: 'cloud' }),
  execution('no-session', { cost: 5, sessionId: undefined }),
  execution('zero', { cost: 0 }),
  execution('flat-fee', { flatFee: true }),
];
const flatFeeHistory = [execution('flat-fee', { flatFee: true })];
const partialHistory = [
  execution('running', { status: 'running', cost: 0.01 }),
  execution('interrupted', { status: 'interrupted', cost: 0.02 }),
];
const settledFailureHistory = [
  execution('failed', { status: 'failed', cost: 0.5 }),
  execution('cancelled', { status: 'cancelled', cost: 0.7 }),
];

const cases = [
  { name: 'highlights 720 local runs and shows the first-run cost message', draft: draft(twoMinutes), history: [], value: 'About 720 runs/day · cost visible after the first run', highlight: true },
  { name: 'uses the median positive local session cost', draft: draft(twoMinutes), history: paidHistory, value: 'About 720 runs/day · about $144.0000/day', highlight: true },
  { name: 'keeps cost unknown with only partial runs', draft: draft(twoMinutes), history: partialHistory, value: 'About 720 runs/day · cost visible after the first run', highlight: true },
  { name: 'excludes partial runs from the cost median', draft: draft(twoMinutes), history: [...partialHistory, ...paidHistory], value: 'About 720 runs/day · about $144.0000/day', highlight: true },
  { name: 'counts failed and cancelled runs that persisted a cost over completed flat-fee history', draft: draft(twoMinutes), history: [...settledFailureHistory, ...flatFeeHistory], value: 'About 720 runs/day · about $432.0000/day', highlight: true },
  { name: 'uses failed run cost when there is no completed run', draft: draft(twoMinutes), history: [settledFailureHistory[0]], value: 'About 720 runs/day · about $360.0000/day', highlight: true },
  { name: 'keeps completed flat-fee history with partial costs', draft: draft(twoMinutes), history: [...partialHistory, ...flatFeeHistory], value: 'About 720 runs/day · not billed in USD', highlight: true },
  { name: 'shows a flat-fee history without a dollar figure', draft: draft(twoMinutes), history: flatFeeHistory, value: 'About 720 runs/day · not billed in USD', highlight: true },
  { name: 'shows about one run per day for regular daily cron', draft: draft(daily), history: [], value: 'About 1 run/day · cost visible after the first run' },
  { name: 'shows less than one run per day for weekly cron', draft: draft({ type: 'cron', expression: '0 9 * * 1', timezone: 'UTC' }), history: [], value: 'Less than one run/day · cost visible after the first run' },
  { name: 'shows less than one run per day for monthly cron', draft: draft({ type: 'cron', expression: '0 9 1 * *', timezone: 'UTC' }), history: [], value: 'Less than one run/day, based on the shortest gap between runs · cost visible after the first run' },
  { name: 'keeps a nonzero daily cost for every three days', draft: draft({ type: 'every', interval: 3, unit: 'days' }), history: [execution('paid', { cost: 0.3 })], value: 'Less than one run/day · about $0.1000/day' },
  { name: 'leaves hourly jobs unhighlighted', draft: draft(hourly), history: [], value: 'About 24 runs/day · cost visible after the first run' },
  { name: 'explains the shortest interval of an irregular schedule', draft: draft(irregular), history: [], value: 'At most about 288 runs/day, based on the shortest gap between runs · cost visible after the first run', highlight: true },
  { name: 'omits money and highlight for cloud jobs', draft: draft(twoMinutes, { runsOn: 'cloud' }), history: paidHistory, value: 'About 720 runs/day' },
  { name: 'omits money for shell actions', draft: draft(hourly, { action: shell }), history: paidHistory, value: 'About 24 runs/day' },
  { name: 'omits the row for a one-time job', draft: draft(at), history: paidHistory },
  { name: 'omits the row for an event job', draft: draft(event), history: paidHistory },
];

afterEach(() => {
  cleanup();
  getRecentExecutions.mockReset();
});

function EditableChatCard({ initialDraft }: { initialDraft: PendingScheduleDraft }) {
  const [pending, setPending] = useState(initialDraft);
  return <ScheduleConfirmCard draft={pending} confirming={false} onConfirm={noop} onDismiss={noop} onDraftChange={setPending} />;
}

describe('buildScheduleConfirmRows schedule estimate', () => {
  it.each(cases)('$name', ({ draft: pending, history, value, highlight }) => {
    const estimate = buildScheduleConfirmRows(pending, en.scheduleConfirm, 'en', undefined, history)
      .find((row) => row.key === 'estimate');
    expect(estimate?.value).toBe(value);
    expect(estimate?.hint).toBe(highlight ? 'Shorter intervals use up your quota faster.' : undefined);
  });

  it('uses Chinese copy and averages the two middle positive costs for a role wake', () => {
    const pending = draft(hourly, { action: { type: 'role-wake', roleId: 'role' } });
    const rows = buildScheduleConfirmRows(pending, zh.scheduleConfirm, 'zh', undefined, [
      execution('a', { cost: 0.125 }),
      execution('b', { cost: 0.25 }),
    ]);
    expect(rows.find((row) => row.key === 'estimate')?.value).toBe('每天约 24 次 · 每天约 $4.5000');
  });
});

describe.each([
  { path: 'chat confirmation', attr: 'data-schedule-row', card: (pending: PendingScheduleDraft) =>
    <ScheduleConfirmCard draft={pending} confirming={false} onConfirm={noop} onDismiss={noop} /> },
  { path: 'form confirmation', attr: 'data-pending-routine-row', card: (pending: PendingScheduleDraft) =>
    <PendingRoutineRestate input={{ ...pending.input, runsOn: pending.input.runsOn ?? 'local' }} confirming={false} onConfirm={noop} onBack={noop} /> },
])('$path', ({ attr, card }) => {
  it.each(cases)('$name', async ({ draft: pending, history, value, highlight }) => {
    getRecentExecutions.mockResolvedValue(history);
    const view = render(card(pending));
    // Flush the mocked history before checking copy that can also appear on the initial render.
    await act(async () => {});
    const row = view.container.querySelector<HTMLElement>(`[${attr}="estimate"]`);
    if (value === undefined) {
      expect(row).toBeNull();
      expect(getRecentExecutions).not.toHaveBeenCalled();
      return;
    }
    expect(row).not.toBeNull();
    const content = within(row!);
    expect(await content.findByText(value)).toBeTruthy();
    expect(row!.classList.contains('bg-amber-500/10')).toBe(Boolean(highlight));
    expect(Boolean(content.queryByText('Shorter intervals use up your quota faster.'))).toBe(Boolean(highlight));
    if (pending.input.runsOn === 'cloud' || pending.input.action.type === 'shell') {
      expect(getRecentExecutions).not.toHaveBeenCalled();
    }
  });
});

it('updates the estimate when the chat time edit is applied without refetching history', async () => {
  getRecentExecutions.mockResolvedValue([]);
  const view = render(<EditableChatCard initialDraft={draft(twoMinutes)} />);
  const row = view.container.querySelector('[data-schedule-row="estimate"]');
  expect(row?.classList.contains('bg-amber-500/10')).toBe(true);
  fireEvent.click(view.container.querySelector('[data-schedule-edit="when"]')!);
  const editor = view.container.querySelector<HTMLElement>('[data-schedule-when-editor]')!;
  fireEvent.change(within(editor).getByRole('combobox'), { target: { value: 'hourly' } });
  fireEvent.click(editor.querySelector('[data-schedule-when-apply]')!);
  expect(await view.findByText('About 24 runs/day · cost visible after the first run')).toBeTruthy();
  expect(row?.classList.contains('bg-amber-500/10')).toBe(false);
  expect(getRecentExecutions).toHaveBeenCalledTimes(1);
});
