// @vitest-environment jsdom
// ============================================================================
// FB-491：在「执行动作」页首次保存缺预算/账号的事件任务 → 跳回「基本设置」页，
// 内联提示紧挨着要补的字段，顶部表单错误条保持不变；补齐后再保存一次即成功。
// ============================================================================
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAccount } from '../../../src/shared/contract/channel';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { cronCenterEn, cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import { ScheduleConfirmCard } from '../../../src/renderer/components/features/chat/ChatInput/ScheduleConfirmCard';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

const cronStore = vi.hoisted(() => ({
  createJob: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));
vi.mock('../../../src/renderer/stores/cronStore', () => ({
  useCronStore: () => cronStore,
}));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';

const feishuAccount: ChannelAccount = {
  id: 'account-feishu',
  name: '工作飞书',
  type: 'feishu',
  config: { type: 'feishu', appId: 'app-id', appSecret: 'app-secret' },
  status: 'connected',
  enabled: true,
  createdAt: 1,
};

const copy = cronCenterZh.cronCenter;

function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    id: 'job-event',
    name: '盯群消息',
    scheduleType: 'event',
    schedule: { type: 'event', source: 'channel', accountId: 'account-feishu', eventName: 'message' },
    action: { type: 'agent', agentType: 'default', prompt: '处理新消息' },
    runsOn: 'local',
    maxRunBudget: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as CronJobDefinition;
}

function openOnActionTabAndSave(job: CronJobDefinition): void {
  render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
  fireEvent.click(screen.getByText('执行动作'));
  expect(screen.queryByText('调度类型')).toBeNull();
  fireEvent.click(screen.getByText('保存修改'));
}

describe('event validation jumps to the basic tab', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS) return [feishuAccount];
      if (channel === IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS) return { supported: true, conversations: [] };
      return undefined;
    });
    cronStore.updateJob.mockResolvedValue(makeJob({ maxRunBudget: 1 }));
    (window as unknown as { domainAPI?: unknown }).domainAPI = {
      invoke: async () => ({
        success: true,
        data: { ok: true, accounts: [{ name: '_icloud' }], mailboxesByAccount: { _icloud: ['INBOX'] } },
      }),
    };
  });

  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    delete (window as unknown as { domainAPI?: unknown }).domainAPI;
  });

  it('missing budget: lands on basic with the inline message, banner kept, no save; filling budget then saves once', async () => {
    openOnActionTabAndSave(makeJob({}));

    expect(await screen.findByText('调度类型')).toBeTruthy();
    const budget = screen.getByLabelText(/^单次预算上限/) as HTMLInputElement;
    expect(budget).toBeTruthy();
    const inline = screen.getByTestId('cron-event-validation');
    expect(inline.textContent).toBe(copy.eventValidation['requires-budget']);
    // 顶部表单错误条仍在（与内联提示同文案 → 共 2 处）。
    expect(screen.getAllByText(copy.eventValidation['requires-budget'])).toHaveLength(2);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(cronStore.updateJob).not.toHaveBeenCalled();

    fireEvent.change(budget, { target: { value: '1' } });
    fireEvent.click(screen.getByText('执行动作'));
    fireEvent.click(screen.getByText('保存修改'));
    await waitFor(() => expect(cronStore.updateJob).toHaveBeenCalledTimes(1));
  });

  it('missing channel account: lands on basic with the inline invalid-schedule message and the banner', async () => {
    openOnActionTabAndSave(makeJob({
      schedule: { type: 'event', source: 'channel', accountId: '', eventName: 'message' },
      maxRunBudget: 1,
    }));

    expect(await screen.findByText('调度类型')).toBeTruthy();
    expect(screen.getByTestId('cron-event-validation').textContent).toBe(copy.eventValidation['invalid-schedule']);
    expect(screen.getAllByText(copy.eventValidation['invalid-schedule'])).toHaveLength(2);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(cronStore.updateJob).not.toHaveBeenCalled();
  });

  it('missing mail account: lands on basic with the mail inline message and the banner', async () => {
    openOnActionTabAndSave(makeJob({
      schedule: {
        type: 'event', source: 'connector', connector: 'mail', accountId: '', mailbox: 'INBOX', eventName: 'message',
      },
      maxRunBudget: 1,
    }));

    expect(await screen.findByText('调度类型')).toBeTruthy();
    const inline = await screen.findByTestId('cron-event-mail-validation');
    expect(inline.textContent).toBe(copy.eventMailInvalidAccount);
    expect(screen.getAllByText(copy.eventMailInvalidAccount)).toHaveLength(2);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(cronStore.updateJob).not.toHaveBeenCalled();
  });

  it('event-channel: submit with empty budget → red box → type 0.5 → red box gone, no inline requires-budget text', async () => {
    render(<CronJobEditor isOpen job={makeJob({ maxRunBudget: null })} onClose={() => undefined} />);

    fireEvent.click(screen.getByText('保存修改'));
    expect(await screen.findByTestId('cron-event-validation')).toBeTruthy();
    expect(screen.getAllByText(copy.eventValidation['requires-budget'])).toHaveLength(2);

    const budget = screen.getByLabelText(/^单次预算上限/) as HTMLInputElement;
    fireEvent.change(budget, { target: { value: '0.5' } });

    await waitFor(() => {
      expect(screen.queryByText(copy.eventValidation['requires-budget'])).toBeNull();
      expect(screen.queryByTestId('cron-event-validation')).toBeNull();
    });
  });

  it('event-mail: submit with empty budget → red box → type 0.5 → red box gone, no inline requires-budget text', async () => {
    render(
      <CronJobEditor
        isOpen
        job={makeJob({
          schedule: {
            type: 'event', source: 'connector', connector: 'mail', accountId: '_icloud', mailbox: 'INBOX', eventName: 'message',
          },
          maxRunBudget: null,
        })}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('保存修改'));
    expect(await screen.findByTestId('cron-event-mail-validation')).toBeTruthy();
    expect(screen.getAllByText(copy.eventValidation['requires-budget'])).toHaveLength(2);

    const budget = screen.getByLabelText(/^单次预算上限/) as HTMLInputElement;
    fireEvent.change(budget, { target: { value: '0.5' } });

    await waitFor(() => {
      expect(screen.queryByText(copy.eventValidation['requires-budget'])).toBeNull();
      expect(screen.queryByTestId('cron-event-mail-validation')).toBeNull();
    });
  });

  it('non-event form error is NOT cleared by editing the budget field', async () => {
    cronStore.updateJob.mockRejectedValueOnce(new Error('后端保存失败'));
    render(<CronJobEditor isOpen job={makeJob({ maxRunBudget: 1 })} onClose={() => undefined} />);

    fireEvent.click(screen.getByText('保存修改'));
    expect(await screen.findByText('后端保存失败')).toBeTruthy();

    const budget = screen.getByLabelText(/^单次预算上限/) as HTMLInputElement;
    fireEvent.change(budget, { target: { value: '0.5' } });

    expect(screen.getByText('后端保存失败')).toBeTruthy();
  });

  it('eventConstraintsHint and eventValidation["requires-budget"] in zh and en contain no direction words and render on editor + confirm card', () => {
    const strings = [
      cronCenterZh.cronCenter.eventConstraintsHint,
      cronCenterZh.cronCenter.eventValidation['requires-budget'],
      cronCenterEn.cronCenter.eventConstraintsHint,
      cronCenterEn.cronCenter.eventValidation['requires-budget'],
    ];
    for (const s of strings) {
      expect(s).not.toMatch(/上方|下方|\babove\b|\bbelow\b/i);
    }
    expect(cronCenterZh.cronCenter.eventConstraintsHint).toContain('单次预算上限 (USD)');
    expect(cronCenterZh.cronCenter.eventValidation['requires-budget']).toContain('单次预算上限 (USD)');
    expect(cronCenterEn.cronCenter.eventConstraintsHint).toContain('Per-run budget cap (USD)');
    expect(cronCenterEn.cronCenter.eventValidation['requires-budget']).toContain('Per-run budget cap (USD)');

    const { unmount } = render(<CronJobEditor isOpen job={makeJob({ maxRunBudget: 0.5 })} onClose={() => undefined} />);
    const editorHint = screen.getByTestId('cron-event-constraints-hint').textContent ?? '';
    expect(editorHint).toBe(copy.eventConstraintsHint);
    expect(editorHint).not.toMatch(/上方|下方|\babove\b|\bbelow\b/i);
    unmount();

    render(
      <ScheduleConfirmCard
        draft={{
          input: {
            name: '盯群',
            enabled: true,
            scheduleType: 'event',
            schedule: { type: 'event', source: 'channel', accountId: 'account-feishu', eventName: 'message' },
            action: { type: 'agent', agentType: 'default', prompt: '处理' },
            runsOn: 'local',
            maxRunBudget: 0.5,
          },
        }}
        confirming={false}
        onConfirm={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    const confirmHint = screen.getByTestId('cron-event-constraints-hint').textContent ?? '';
    expect(confirmHint).toBe(copy.eventConstraintsHint);
    expect(confirmHint).not.toMatch(/上方|下方|\babove\b|\bbelow\b/i);
  });
});
