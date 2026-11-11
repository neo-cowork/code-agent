// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { cronCenterEn, cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
vi.mock('../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({ accounts: [], accountsLoading: false, conversationsByAccount: {} }),
  useEventScheduleNames: () => () => ({}),
}));
vi.mock('../../../src/renderer/components/features/cron/useMailSources', () => ({
  useMailSources: () => ({ state: { status: 'empty', accounts: [], mailboxesByAccount: {} }, reload: vi.fn() }),
}));
vi.mock('../../../src/renderer/components/features/cron/useCronCloudConfig', () => ({
  useCronCloudConfig: () => ({ loading: false, configured: true }),
}));

import CronJobEditor from '../../../src/renderer/components/features/cron/CronJobEditor';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

type Schedule = 'every' | 'cron' | 'at' | 'event' | 'event-mail' | 'event-webhook';
const schedules: Schedule[] = ['every', 'cron', 'at', 'event', 'event-mail', 'event-webhook'];
const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;

function makeJob(kind: Schedule): CronJobDefinition {
  const schedule: CronJobDefinition['schedule'] = kind === 'every'
    ? { type: 'every', interval: 1, unit: 'hours' }
    : kind === 'cron' ? { type: 'cron', expression: '0 9 * * 1' }
      : kind === 'at' ? { type: 'at', datetime: '2027-11-16T09:00:00.000Z' }
        : kind === 'event-mail' ? { type: 'event', source: 'connector', connector: 'mail', eventName: 'message', accountId: 'Work mail' }
          : kind === 'event-webhook' ? { type: 'event', source: 'webhook', eventName: 'message' }
            : { type: 'event', source: 'channel', eventName: 'message', accountId: 'Work chat' };
  return {
    id: 'weekly-report', name: 'Weekly report', description: 'Summarize project updates',
    scheduleType: schedule.type, schedule,
    action: { type: 'agent', agentType: 'default', prompt: 'Prepare the weekly report' },
    runsOn: 'local', enabled: true, maxRunBudget: 2, maxRuns: 12, runCount: 3,
    createdAt: 1, updatedAt: 1,
  };
}

function open(kind: Schedule, mode: 'create' | 'edit', language: 'en' | 'zh' = 'en', job = makeJob(kind)) {
  useAppStore.setState({ language });
  render(<CronJobEditor isOpen job={mode === 'edit' ? job : null} onClose={() => undefined} />);
  const cc = (language === 'en' ? cronCenterEn : cronCenterZh).cronCenter;
  if (mode === 'create') {
    fireEvent.click(screen.getByText(cc.manualConfig));
    fireEvent.change(screen.getByTestId('cron-schedule-type-select'), { target: { value: kind } });
  }
  return cc;
}

// Collect separate raw text nodes, attributes and every native dropdown option,
// including options that become visible only after opening the dropdown.
function collect() {
  const root = screen.getByRole('dialog');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const text: string[] = [];
  while (walker.nextNode()) {
    const value = walker.currentNode.textContent?.trim();
    if (value) text.push(value);
  }
  const attributes = Array.from(root.querySelectorAll('*')).flatMap((element) =>
    ['placeholder', 'aria-label', 'title', 'hint', 'label'].flatMap((attribute) => {
      const value = element.getAttribute(attribute);
      return value ? [`${attribute}=${value}`] : [];
    }));
  const options = Array.from(root.querySelectorAll('option')).map((option) => option.label);
  return { text, attributes, options };
}

function record(context: string) {
  const result = collect();
  if (process.env.CRON_UI_INVENTORY) console.info('CRON_UI_INVENTORY', JSON.stringify({ context, ...result }));
  return result;
}
function assertEnglish(rows: ReturnType<typeof collect>[]) {
  for (const row of rows) for (const value of [...row.text, ...row.attributes, ...row.options]) {
    expect(value, 'production CronJobEditor UI chrome').not.toMatch(CJK);
  }
}
function submit(cc: typeof cronCenterEn.cronCenter, mode: 'create' | 'edit') {
  fireEvent.click(screen.getByRole('button', { name: mode === 'create' ? cc.editorChrome.createTask : cc.editorChrome.saveChanges }));
}

beforeEach(() => {
  useCronStore.setState({ jobs: [], createJob: vi.fn(), updateJob: vi.fn(), error: null });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.clearAllMocks();
});

describe('production manual cron editor English inventory', () => {
  it.each(schedules.flatMap((kind) => (['create', 'edit'] as const).map((mode) => ({ kind, mode }))))(
    '$mode $kind: Basic / Action / Advanced, unit options and empty-required validation have zero CJK',
    ({ kind, mode }) => {
      const cc = open(kind, mode);
      expect(screen.getByText('Schedule type')).toBeTruthy();
      const rows: ReturnType<typeof collect>[] = [];
      for (const tab of ['basic', 'action', 'advanced'] as const) {
        fireEvent.click(screen.getByText(cc.editorChrome.tabs[tab]));
        if (tab === 'action') fireEvent.click(screen.queryByText(cc.manualEditor.extraParametersDisclosure) ?? screen.getByText(cc.editorChrome.tabs.action));
        rows.push(record(`${mode}/${kind}/${tab}`));
        if (tab === 'advanced') {
          expect(screen.getByTestId('cron-retry-delay-unit').textContent).toContain('seconds');
          expect(screen.getByTestId('cron-timeout-unit').textContent).toContain('hours');
        }
      }
      fireEvent.click(screen.getByText('Basic'));
      if (kind === 'every') {
        const units = screen.getAllByRole('combobox').find((select) => select.querySelector('option[value="days"]'))!;
        for (const unit of ['minutes', 'days']) {
          fireEvent.change(units, { target: { value: unit } });
          rows.push(record(`${mode}/${kind}/basic-${unit}`));
        }
      }
      fireEvent.change(screen.getByPlaceholderText(cc.editorChrome.taskNamePlaceholder), { target: { value: '' } });
      submit(cc, mode);
      expect(screen.getByRole('dialog').querySelector('.text-badge-danger')).toBeTruthy();
      for (const tab of ['basic', 'action', 'advanced'] as const) {
        fireEvent.click(screen.getByText(cc.editorChrome.tabs[tab]));
        rows.push(record(`${mode}/${kind}/${tab}-validation`));
      }
      expect(useCronStore.getState().createJob).not.toHaveBeenCalled();
      expect(useCronStore.getState().updateJob).not.toHaveBeenCalled();
      assertEnglish(rows);
    },
  );

  it.each([
    ['name', '任务名称不能为空'], ['interval', '间隔必须大于 0'], ['at', '请选择执行时间'],
    ['cron', 'Cron 表达式不能为空'], ['budget', '单次预算上限必须是大于等于 0 的数字'],
    ['runs', '运行次数上限必须是大于等于 1 的整数'], ['shell', 'Shell 命令不能为空'],
    ['tool', 'Tool 名称不能为空'], ['tool-json', 'Tool 参数 must be valid JSON'],
    ['agent-type', 'Agent 类型不能为空'], ['unknown-agent', 'Agent 类型“missing”不存在，可选值：default、heartbeat、dream、distill。'],
    ['prompt', 'Prompt 不能为空'], ['webhook', 'Webhook URL 不能为空'], ['ipc', 'IPC channel 不能为空'],
  ] as const)('%s validation rejects the same input in en and preserves the zh message', (field, zhMessage) => {
    for (const language of ['en', 'zh'] as const) {
      const kind = field === 'at' || field === 'cron' ? field : 'every';
      const job = makeJob(kind);
      if (field === 'name') job.name = '';
      if (field === 'interval') job.schedule = { type: 'every', interval: 0, unit: 'hours' };
      if (field === 'at') job.schedule = { type: 'at', datetime: '' };
      if (field === 'cron') job.schedule = { type: 'cron', expression: '' };
      if (field === 'budget') job.maxRunBudget = -1;
      if (field === 'runs') job.maxRuns = 0;
      if (field === 'shell') job.action = { type: 'shell', command: '' };
      if (field === 'tool' || field === 'tool-json') job.action = { type: 'tool', toolName: field === 'tool' ? '' : 'Generate report', parameters: {} };
      if (field === 'agent-type') job.action = { type: 'agent', agentType: '', prompt: 'Prepare the report' };
      if (field === 'unknown-agent') job.action = { type: 'agent', agentType: 'missing', prompt: 'Prepare the report' };
      if (field === 'prompt') job.action = { type: 'agent', agentType: 'default', prompt: '' };
      if (field === 'webhook') job.action = { type: 'webhook', url: '', method: 'POST' };
      if (field === 'ipc') job.action = { type: 'ipc', channel: '', payload: {} };
      const cc = open(kind, 'edit', language, job);
      fireEvent.click(screen.getByText(cc.editorChrome.tabs.action));
      if (field === 'tool-json') fireEvent.change(screen.getAllByRole('textbox').at(-1)!, { target: { value: '{' } });
      // Some stored empty values are normalized when loading; clear the actual control.
      if (field === 'agent-type') fireEvent.change(screen.getByTestId('cron-agent-type-select'), { target: { value: '' } });
      submit(cc, 'edit');
      const row = record(`${language}/validation/${field}`);
      expect(useCronStore.getState().updateJob).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog').querySelector('.text-badge-danger')).toBeTruthy();
      if (language === 'en') assertEnglish([row]);
      else expect(screen.getByText(zhMessage)).toBeTruthy();
      cleanup();
    }
  });

  it.each(schedules)('zh %s keeps the original chrome across all three tabs', (kind) => {
    open(kind, 'edit', 'zh');
    for (const label of ['任务名称', '调度类型', '基本设置', '执行动作', '高级选项', '保存修改']) expect(screen.getByText(label)).toBeTruthy();
    fireEvent.click(screen.getByText('执行动作'));
    expect(screen.getByText(cronCenterZh.cronCenter.manualEditor.taskInstructionsLabel)).toBeTruthy();
    fireEvent.click(screen.getByText('高级选项'));
    for (const label of ['配置重试策略和执行超时，通常保持默认即可。', '最大重试次数', '运行次数上限']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByTestId('cron-retry-delay-unit').textContent).toContain('秒');
  });
});
