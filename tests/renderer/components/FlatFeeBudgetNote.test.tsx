// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { on: vi.fn(() => () => undefined), invoke: vi.fn(async () => undefined), invokeDomain: vi.fn(async () => undefined) },
}));

import { FlatFeeBudgetNote } from '../../../src/renderer/components/features/cron/FlatFeeBudgetNote';
import { CronRunBudgetField } from '../../../src/renderer/components/features/cron/CronRunBudgetField';
import { CronWebhookScheduleFields } from '../../../src/renderer/components/features/cron/CronWebhookScheduleFields';
import { CronMailEventFields } from '../../../src/renderer/components/features/cron/CronMailEventFields';
import { CronEventScheduleFields } from '../../../src/renderer/components/features/cron/CronEventScheduleFields';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { ModelConfig } from '../../../src/shared/contract/model';
import { ScheduleConfirmCard } from '../../../src/renderer/components/features/chat/ChatInput/ScheduleConfirmCard';
import type { PendingScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraft';

function setModel(provider: string, model: string, language: 'zh' | 'en') {
  const base = useAppStore.getState().modelConfig;
  useAppStore.setState({ language, modelConfig: { ...base, provider, model } as ModelConfig });
}

afterEach(cleanup);

function ScheduleCardHarness({ initial }: { initial: PendingScheduleDraft }) {
  const [draft, setDraft] = useState(initial);
  return <ScheduleConfirmCard draft={draft} confirming={false} onConfirm={() => undefined}
    onDismiss={() => undefined} onDraftChange={setDraft} />;
}

describe('ScheduleConfirmCard flat-fee budget note', () => {
  it.each([
    ['channel', 'zh'], ['channel', 'en'], ['mail', 'zh'], ['mail', 'en'],
  ] as const)('%s draft (%s): live model changes preserve the edited budget', async (source, language) => {
    setModel('xiaomi', 'mimo-v2.6-flash', language);
    const draft: PendingScheduleDraft = {
      draftId: 1,
      sourceSessionId: null,
      description: 'Summarize incoming messages',
      input: {
        name: 'Message summary', enabled: true, runsOn: 'local', scheduleType: 'event',
        schedule: source === 'mail'
          ? { type: 'event', source: 'connector', connector: 'mail', eventName: 'message', accountId: 'test-account' }
          : { type: 'event', source: 'channel', eventName: 'message', accountId: 'test-account' },
        action: { type: 'agent', agentType: 'default', prompt: 'Summarize the incoming message' },
        maxRunBudget: 0.5,
      },
    };
    const { container } = render(<ScheduleCardHarness initial={draft} />);
    // Flush source-catalog effects without mocking either of the actual field components.
    await act(async () => undefined);
    const budget = screen.getByRole('spinbutton') as HTMLInputElement;
    const note = screen.getByRole('note');
    expect(container.querySelector('[data-schedule-confirm]')?.contains(note)).toBe(true);
    expect(container.querySelector('[data-schedule-event-fields]')?.contains(note)).toBe(true);
    expect(budget.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.textContent).toContain('mimo-v2.6-flash');
    expect(note.textContent).toContain(language === 'zh' ? '美元上限对它不生效' : 'flat-fee model');

    fireEvent.change(budget, { target: { value: '0.75' } });
    act(() => setModel('deepseek', 'deepseek-chat', language));
    expect(screen.queryAllByTestId('flat-fee-budget-note')).toHaveLength(0);
    expect(screen.getByRole('spinbutton')).toBe(budget);
    expect(budget.value).toBe('0.75');

    act(() => setModel('xiaomi', 'mimo-v2.6-flash', language));
    expect(screen.getAllByTestId('flat-fee-budget-note')).toHaveLength(1);
    expect(budget.value).toBe('0.75');
  });

  it('time-only draft has neither the event budget input nor its note', () => {
    setModel('xiaomi', 'mimo-v2.6-flash', 'zh');
    render(<ScheduleCardHarness initial={{
      sourceSessionId: null, description: 'Summarize messages every hour',
      input: {
        name: 'Hourly summary', enabled: true, runsOn: 'local', scheduleType: 'every',
        schedule: { type: 'every', interval: 1, unit: 'hours' },
        action: { type: 'agent', agentType: 'default', prompt: 'Summarize messages' },
      },
    }} />);
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByTestId('flat-fee-budget-note')).toBeNull();
  });
});

describe('FlatFeeBudgetNote', () => {
  it('包月默认模型：zh 提示点名模型并给出路', () => {
    setModel('xiaomi', 'mimo-v2.6-flash', 'zh');
    render(<FlatFeeBudgetNote variant="cron" />);
    const note = screen.getByTestId('flat-fee-budget-note');
    expect(note.textContent).toContain('mimo-v2.6-flash');
    expect(note.textContent).toContain('包月模型，不按美元计费，美元上限对它不生效');
    expect(note.textContent).toContain('执行超时');
  });

  it('包月默认模型：en 提示', () => {
    setModel('xiaomi', 'mimo-v2.6-flash', 'en');
    render(<FlatFeeBudgetNote variant="settings" />);
    expect(screen.getByTestId('flat-fee-budget-note').textContent)
      .toContain('flat-fee model and is not billed in USD');
  });

  it.each(['zh', 'en'] as const)('glm-5.3 按量计价：%s 下不渲染', (language) => {
    setModel('zhipu', 'glm-5.3', language);
    const { container } = render(<FlatFeeBudgetNote variant="cron" />);
    expect(container.innerHTML).toBe('');
  });

  it('三个 cron 预算字段在包月模型下都渲染提示，按量模型下没有', () => {
    const noop = () => undefined;
    const renderAll = () => render(
      <>
        <CronWebhookScheduleFields loading={false} configured onGotoSettings={noop} maxRunBudget="1" onBudgetChange={noop} validationMessage={null} />
        <CronMailEventFields accountId="a" mailbox="" onAccountChange={noop} onMailboxChange={noop} maxRunBudget="1" onBudgetChange={noop} violation={null} />
        <CronEventScheduleFields accountId="a" chatId="" onAccountChange={noop} onChatChange={noop} maxRunBudget="1" onBudgetChange={noop} validationMessage={null} />
      </>,
    );
    setModel('xiaomi', 'mimo-v2.6-flash', 'zh');
    renderAll();
    expect(screen.getAllByTestId('flat-fee-budget-note')).toHaveLength(3);
    cleanup();
    setModel('zhipu', 'glm-5.3', 'zh');
    renderAll();
    expect(screen.queryAllByTestId('flat-fee-budget-note')).toHaveLength(0);
  });

  it('普通 cron 编辑器的「单次花费上限」：包月模型显示，deepseek-chat 不显示', () => {
    setModel('xiaomi', 'mimo-v2.6-flash', 'zh');
    const { container } = render(<CronRunBudgetField value="" onChange={() => undefined} />);
    const input = screen.getByTestId('cron-budget-limit-input');
    const note = screen.getByTestId('flat-fee-budget-note');
    expect(input.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    setModel('deepseek', 'deepseek-chat', 'zh');
    const again = render(<CronRunBudgetField value="" onChange={() => undefined} />);
    expect(screen.queryByTestId('flat-fee-budget-note')).toBeNull();
    expect(container).toBeTruthy();
    again.unmount();
  });
});
