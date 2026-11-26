// @vitest-environment jsdom
// ============================================================================
// N-TRIGGER-OBSERVE-MODE ④：自动化详情显示执行方式徽标 + 逐事件决策记录（本会执行高亮）；
// 「切换为自动执行」必须过确认弹窗，确认后才调 host 的 setEventActionMode（host 写变更事件）。
// ============================================================================
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronEventDecision, CronJobDefinition } from '../../../src/shared/contract/cron';

const clientState = vi.hoisted(() => ({
  getEventDecisions: vi.fn(),
  getEventActionModeChange: vi.fn(),
  setEventActionMode: vi.fn(),
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    getGroupListenCheck: vi.fn().mockResolvedValue({ status: 'idle' }),
    startGroupListenCheck: vi.fn(),
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getEventDecisions: clientState.getEventDecisions,
    getEventActionModeChange: clientState.getEventActionModeChange,
    setEventActionMode: clientState.setEventActionMode,
  },
}));

import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { settleEventRunDecisions } from '../../../src/host/cron/cronEventDecisions';
import { cronFailureSourceText } from '../../../src/shared/utils/cronFailureClassification';
import { ProjectSourceTrustError } from '../../../src/host/services/project/projectSourceTrustError';
import type { ProjectSourceTrustFailureKind } from '../../../src/shared/contract/project';

function eventJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-listen',
    runsOn: 'local',
    name: '盯客服群',
    scheduleType: 'event',
    schedule: { type: 'event', source: 'connector', connector: 'mail', accountId: '_icloud', eventName: 'message' },
    action: { type: 'agent', agentType: 'default', prompt: '回复客户邮件' },
    enabled: true,
    actionMode: 'observe',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const decisions: CronEventDecision[] = [
  {
    id: 'd1', jobId: 'job-listen', kind: 'action', decision: 'would_act', reason: 'observe mode: mail_send intercepted before sending',
    runId: 'run-1', tool: 'mail_send', target: 'client@example.com', summary: 'Re: invoice — We will refund you today.', createdAt: 3,
  },
  {
    id: 'd2', jobId: 'job-listen', kind: 'event', eventId: '163|INBOX|430', eventLabel: '王阿姨 · 退款什么时候到账', decision: 'would_act', reason: '客户要求退款', runId: 'run-1',
    matchedRule: 'mail message · account _icloud · mailbox INBOX', createdAt: 2,
  },
  {
    id: 'd3', jobId: 'job-listen', kind: 'event', eventId: '163|INBOX|431', decision: 'ignored', reason: '广告邮件', runId: 'run-1',
    matchedRule: 'mail message · account _icloud · mailbox INBOX', createdAt: 1,
  },
];

beforeEach(() => {
  clientState.getEventDecisions.mockReset();
  clientState.getEventActionModeChange.mockReset();
  clientState.setEventActionMode.mockReset();
  clientState.getEventDecisions.mockResolvedValue(decisions);
  clientState.getEventActionModeChange.mockResolvedValue(null);
  useAppStore.setState({ language: 'zh' });
});

afterEach(() => {
  cleanup();
  useCronStore.setState({ jobs: [] });
});

describe('CronEventDecisionsPanel (via CronJobDetail)', () => {
  it.each([
    { tool: '飞书 回复消息', reason: 'outbound action 飞书 回复消息 intercepted in observe mode', zhTool: '飞书 回复消息', enTool: '飞书 回复消息' },
    { tool: '飞书 回复消息', reason: 'observe mode: 飞书 回复消息 intercepted before sending', zhTool: '飞书 回复消息', enTool: '飞书 回复消息' },
    { tool: 'channel_reply', reason: 'outbound action channel_reply intercepted in observe mode', zhTool: '通道回复', enTool: 'Channel reply' },
    { tool: 'channel_reply', reason: 'observe mode: channel reply intercepted before sending', zhTool: '通道回复', enTool: 'Channel reply' },
  ].flatMap((row) => (['zh', 'en'] as const).map((language) => ({ ...row, language }))))(
    'renders readable action label and reason in $language: $reason',
    async ({ tool, reason, zhTool, enTool, language }) => {
      useAppStore.setState({ language });
      clientState.getEventDecisions.mockResolvedValue([{
        ...decisions[0], tool, reason, target: 'om_rr51_1', summary: 'RR51-PONG 收到',
      }]);
      render(<CronJobDetail job={eventJob()} />);
      const row = await screen.findByTestId('cron-event-would-act-row');
      const defaultLine = within(row).getByTestId('cron-event-decision-default');
      const details = within(row).getByTestId('cron-event-decision-details');
      const label = language === 'zh' ? zhTool : enTool;
      const expectedReason = language === 'zh'
        ? `仅观察模式：已拦下「${label}」，没有真的发出去`
        : `Observe mode stopped “${label}”; nothing was sent`;
      expect(defaultLine.textContent).toContain(label);
      expect(within(defaultLine).getByText(expectedReason)).toBeTruthy();
      expect(within(details).getByText(expectedReason)).toBeTruthy();
      expect(defaultLine.textContent).toContain('RR51-PONG 收到');
      expect(row.textContent).not.toMatch(/channel_reply|lark-cli|Bash/);
      if (language === 'zh') expect(row.textContent).not.toMatch(/intercepted|observe mode/i);
      process.stdout.write(`[PANEL LOCALIZED ${language}] ${JSON.stringify({ stored: reason, label, rendered: defaultLine.textContent })}\n`);
    },
  );

  it('shows the observe badge; would_act rows sit in their own highlighted section with matched rule, out of the general list', async () => {
    render(<CronJobDetail job={eventJob()} />);
    const badge = screen.getByTestId('cron-action-mode-badge');
    expect(badge.getAttribute('data-mode')).toBe('observe');
    expect(badge.textContent).toContain('仅观察');

    // 返修③：「会接单但未执行」单独一节，would_act 行（事件 + 拦下的动作）都在里面。
    const section = await screen.findByTestId('cron-event-would-act-section');
    expect(clientState.getEventDecisions).toHaveBeenCalledWith('job-listen');
    expect(section.textContent).toContain('会接单但未执行');
    const sectionRows = within(section).getAllByTestId('cron-event-would-act-row');
    expect(sectionRows.map((row) => row.getAttribute('data-decision'))).toEqual(['would_act', 'would_act']);
    expect(sectionRows.map((row) => row.getAttribute('data-highlight'))).toEqual(['true', 'true']);
    expect(sectionRows[0].textContent).toContain('本会执行');
    expect(sectionRows[0].textContent).toContain('发送邮件');
    expect(sectionRows[0].textContent).toContain('client@example.com');
    expect(sectionRows[0].textContent).toContain('We will refund you today.');
    // 事件行带「命中的任务规则」（返修②）。
    expect(within(sectionRows[1]).getByTestId('cron-event-decision-rule').textContent)
      .toContain('邮件 · 账号 _icloud · 收件箱 INBOX');
    expect(within(sectionRows[1]).getByTestId('cron-event-decision-default').textContent).toContain('王阿姨 · 退款什么时候到账');
    expect(within(sectionRows[1]).getByTestId('cron-event-decision-default').textContent).not.toContain('163|INBOX|430');

    // 其余决策（非 would_act）留在总列表里：would_act 不得混入。
    const generalRows = await screen.findAllByTestId('cron-event-decision-row');
    expect(generalRows.map((row) => row.getAttribute('data-decision'))).toEqual(['ignored']);
    expect(generalRows[0].textContent).toContain('广告邮件');
    expect(within(generalRows[0]).getByTestId('cron-event-decision-default').textContent).toContain('第 431 封邮件');
    expect(within(generalRows[0]).getByTestId('cron-event-decision-rule').textContent)
      .toContain('邮件 · 账号 _icloud · 收件箱 INBOX');
  });

  it.each([
    { language: 'zh' as const, reason: '客户明确要求退款', expected: '客户明确要求退款' },
    { language: 'en' as const, reason: 'Customer explicitly requested a refund', expected: 'Customer explicitly requested a refund' },
    {
      language: 'zh' as const,
      reason: 'no outbound action attempted (no per-event reason stated)',
      expected: '这个事件未触发任何对外操作；模型没有说明每个事件的原因',
    },
    {
      language: 'en' as const,
      reason: 'no outbound action attempted (no per-event reason stated)',
      expected: 'This event did not trigger any outbound action; The model gave no reason for this event',
    },
  ])('renders model/fallback reason verbatim or localized in $language', async ({ language, reason, expected }) => {
    useAppStore.setState({ language });
    clientState.getEventDecisions.mockResolvedValue([{ ...decisions[2], reason }]);
    render(<CronJobDetail job={eventJob()} />);
    const row = await screen.findByTestId('cron-event-decision-row');
    expect(within(row).getByTestId('cron-event-decision-default').textContent).toContain(expected);
  });

  it('keeps the raw mail id out of the default line and exposes it only in expandable details with copy controls', async () => {
    clientState.getEventDecisions.mockResolvedValue([decisions[1]]);
    render(<CronJobDetail job={eventJob()} />);
    const row = await screen.findByTestId('cron-event-would-act-row');
    const defaultLine = within(row).getByTestId('cron-event-decision-default');
    expect(defaultLine.textContent).toContain('王阿姨 · 退款什么时候到账');
    expect(defaultLine.textContent).not.toContain('163|INBOX|430');

    const details = within(row).getByTestId('cron-event-decision-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(within(details).getByText('查看详情'));
    expect(details.open).toBe(true);
    expect(within(details).getByText('163|INBOX|430')).toBeTruthy();
    expect(within(details).getByTestId('cron-event-decision-copy-event')).toBeTruthy();
    expect(within(details).getByText('run-1')).toBeTruthy();
    expect(within(details).getByTestId('cron-event-decision-copy-run')).toBeTruthy();
    expect(details.textContent).toContain('规则');
    expect(details.textContent).toContain('决策');
    expect(details.textContent).toContain('原因');
    expect(details.textContent).toContain('运行时间');
  });

  it('switch to auto opens a confirm modal; cancelling does not call the host', async () => {
    render(<CronJobDetail job={eventJob()} />);
    fireEvent.click(screen.getByTestId('cron-switch-to-auto'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('让这个自动化开始真实执行？')).toBeTruthy();
    fireEvent.click(screen.getByText('先不切换'));
    expect(clientState.setEventActionMode).not.toHaveBeenCalled();
  });

  it('confirming the modal calls setEventActionMode(auto), updates the job and shows the change-history entry', async () => {
    const job = eventJob();
    useCronStore.setState({ jobs: [job] });
    let switched = false;
    clientState.getEventActionModeChange.mockImplementation(async () => (
      switched ? { from: 'observe', to: 'auto', at: 2 } : null
    ));
    clientState.setEventActionMode.mockImplementation(async () => {
      switched = true;
      return { ...job, actionMode: 'auto', updatedAt: 2 };
    });
    const { rerender } = render(<CronJobDetail job={job} />);
    expect(screen.queryByTestId('cron-action-mode-change')).toBeNull();
    fireEvent.click(screen.getByTestId('cron-switch-to-auto'));
    await act(async () => { fireEvent.click(await screen.findByText('确认切换')); });
    expect(clientState.setEventActionMode).toHaveBeenCalledWith('job-listen', 'auto');
    await waitFor(() => expect(useCronStore.getState().jobs[0]?.actionMode).toBe('auto'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // 返修⑥：切换后（父层按 store 新任务重渲染）详情页能看到变更记录行，徽标翻成自动执行。
    rerender(<CronJobDetail job={{ ...job, actionMode: 'auto', updatedAt: 2 }} />);
    const change = await screen.findByTestId('cron-action-mode-change');
    expect(change.textContent).toContain('由「仅观察」切换为「自动执行」');
    expect(screen.getByTestId('cron-action-mode-badge').getAttribute('data-mode')).toBe('auto');
  });

  it('auto mode shows the auto badge and no switch action; time-based jobs show no panel', async () => {
    const { unmount } = render(<CronJobDetail job={eventJob({ actionMode: 'auto' })} />);
    expect(screen.getByTestId('cron-action-mode-badge').getAttribute('data-mode')).toBe('auto');
    expect(screen.queryByTestId('cron-switch-to-auto')).toBeNull();
    await screen.findAllByTestId('cron-event-decision-row');
    unmount();
    render(<CronJobDetail job={eventJob({ scheduleType: 'cron', schedule: { type: 'cron', expression: '0 9 * * *' }, actionMode: undefined })} />);
    expect(screen.queryByTestId('cron-event-decisions')).toBeNull();
  });

  // N-FIX-CRON-RUN-ERROR-TRUST-RAW-ENGLISH-PATH 返修 r2：事件触发的运行撞上项目文件夹信任失败时，
  // host 把台账原因落成 "run failed: <execution.error>"，execution.error 是内部标记
  // PROJECT_SOURCE_TRUST:<kind>:<文件夹名>。面板必须显示与运行记录同一句人话（文件夹名 + 下一步），
  // 不露内部标记；修复前落库的英文原句 + 本机绝对路径行同样处理。
  describe('项目文件夹信任失败的决策原因', () => {
    /** 生产入口：host 从失败运行结算出的台账原因（execution.error 是 cronService 落库的稳定标记）。 */
    function settledReason(kind: ProjectSourceTrustFailureKind): string {
      return settleEventRunDecisions({
        jobId: 'job-listen',
        mode: 'observe',
        carriedEventIds: ['163|INBOX|432'],
        dropped: [],
        execution: {
          id: 'run-trust',
          status: 'failed',
          error: cronFailureSourceText(new ProjectSourceTrustError(kind, '/Users/someone/work/notes-proj')),
        },
        observeActionCount: () => 0,
      })[0].reason;
    }

    const sentences = {
      identity_changed: {
        zh: '项目文件夹“{name}”已被替换，请重新选择并确认。请打开项目设置，重新确认这个文件夹，然后再运行一次。',
        en: "Project folder “{name}” has been replaced. Re-select and confirm it. Open the project's settings, re-confirm the folder, then run again.",
      },
      source_missing: {
        zh: '找不到项目文件夹“{name}”。它可能已被移动或删除。请打开项目设置，重新确认这个文件夹，然后再运行一次。',
        en: "Cannot find project folder “{name}”. It may have been moved or deleted. Open the project's settings, re-confirm the folder, then run again.",
      },
      not_trusted: {
        zh: '此项目文件夹尚未获得信任，请在项目设置中确认。请打开项目设置，重新确认这个文件夹，然后再运行一次。',
        en: "This project folder is not trusted. Confirm it in project settings. Open the project's settings, re-confirm the folder, then run again.",
      },
    } satisfies Record<ProjectSourceTrustFailureKind, Record<'zh' | 'en', string>>;

    const trustRows = [
      ...(Object.keys(sentences) as ProjectSourceTrustFailureKind[]).map((kind) => ({
        label: `新标记行 ${kind}`, kind, folderName: 'notes-proj', reason: settledReason(kind),
      })),
      {
        label: '存量英文行', kind: 'identity_changed' as const, folderName: 'proj',
        reason: 'run failed: Project Source trust identity changed: /Users/x/proj',
      },
    ];

    it('host 结算出的台账原因只带稳定标记，不带英文句和路径', () => {
      expect(settledReason('identity_changed')).toBe('run failed: PROJECT_SOURCE_TRUST:identity_changed:notes-proj');
      expect(settledReason('source_missing')).not.toMatch(/Project Source|\/Users\//);
    });

    it.each(trustRows.flatMap((row) => (['zh', 'en'] as const).map((language) => ({ ...row, language }))))(
      '$label 在 $language 显示人话，不带内部标记、英文原句和路径',
      async ({ kind, folderName, reason, language }) => {
        useAppStore.setState({ language });
        clientState.getEventDecisions.mockResolvedValue([{
          ...decisions[2], id: 'd-trust', eventId: '163|INBOX|432', decision: 'unavailable', reason, runId: 'run-1',
          createdAt: 1_762_000_002_000,
        }]);
        render(<CronJobDetail job={eventJob()} />);
        const list = await screen.findByTestId('cron-event-decision-list');
        const row = within(list).getByTestId('cron-event-decision-row');
        const defaultLine = within(row).getByTestId('cron-event-decision-default');
        const details = within(row).getByTestId('cron-event-decision-details');
        process.stdout.write(`[PANEL TRUST ${language}] ${JSON.stringify({ stored: reason, rendered: defaultLine.textContent })}\n`);
        expect(row.getAttribute('data-decision')).toBe('unavailable');
        expect(row.textContent).not.toMatch(/PROJECT_SOURCE_TRUST|Project Source|\/Users\//);
        const expected = (language === 'zh' ? '运行未完成（失败）：' : 'Run failed: ')
          + sentences[kind][language].replace('{name}', folderName);
        expect(within(defaultLine).getByText(expected)).toBeTruthy();
        expect(within(details).getByText(expected)).toBeTruthy();
      },
    );
  });

  it('a failed switch keeps the modal open and shows the error', async () => {
    clientState.setEventActionMode.mockRejectedValue(new Error('record missing'));
    render(<CronJobDetail job={eventJob()} />);
    fireEvent.click(screen.getByTestId('cron-switch-to-auto'));
    await act(async () => { fireEvent.click(await screen.findByText('确认切换')); });
    expect((await screen.findByRole('alert')).textContent).toContain('record missing');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
