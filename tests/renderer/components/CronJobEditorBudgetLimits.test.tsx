// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import type { MCPServerStateSummary } from '../../../src/renderer/hooks/useMcpServerStates';

let mockMcpServerStates: MCPServerStateSummary[] = [];
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => mockMcpServerStates,
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { buildCronJobInput, buildDraftFromJob, createDefaultCronJobDraft } from '../../../src/renderer/components/features/cron/types';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { ModelConfig } from '../../../src/shared/contract/model';

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-budget',
    name: '受限任务',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action: { type: 'shell', command: 'echo ok' },
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useCronStore.setState({
    jobs: [],
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    selectedJobId: null,
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    error: null,
    createJob: vi.fn(),
    updateJob: vi.fn(),
  });
  useAppStore.setState({ language: initialLanguage, modelConfig: initialModelConfig });
  mockMcpServerStates = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openAdvancedTab(job: CronJobDefinition, language: 'zh' | 'en' = 'zh') {
  render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
  fireEvent.click(screen.getByText(language === 'en' ? 'Advanced' : '高级选项'));
}

// N-FIX-CRON-EDITOR-USD-CAP-NO-FLATFEE-NOTE：包月模型判据与 FlatFeeBudgetNote 同源（shared 价表）。
const initialLanguage = useAppStore.getState().language;
const initialModelConfig = useAppStore.getState().modelConfig;
function setModel(provider: string, model: string, language: 'zh' | 'en'): void {
  useAppStore.setState({ language, modelConfig: { ...initialModelConfig, provider, model } as ModelConfig });
}

describe('N-CRON-BUDGET-EXPOSE 编辑器额度字段', () => {
  it('本地任务的高级选项展示单次预算与运行次数上限，并显示已跑计数', () => {
    openAdvancedTab(makeJob({ maxRunBudget: 0.5, maxRuns: 3, runCount: 2 }));

    expect(screen.getByText('单次预算上限 (USD)')).toBeTruthy();
    expect(screen.getByText('运行次数上限')).toBeTruthy();
    expect(screen.getByText(/已运行 2\/3 次/)).toBeTruthy();
    expect(screen.getByDisplayValue('0.5')).toBeTruthy();
    expect(screen.getByDisplayValue('3')).toBeTruthy();
  });

  it('云端任务不展示这两个字段', () => {
    openAdvancedTab(makeJob({ runsOn: 'cloud', schedule: { type: 'every', interval: 2, unit: 'hours' } }));

    expect(screen.queryByText('单次预算上限 (USD)')).toBeNull();
    expect(screen.queryByText('运行次数上限')).toBeNull();
  });

  it('buildCronJobInput emits numbers for filled fields and null for empty ones (PR#2208 R4)', () => {
    const filled = createDefaultCronJobDraft();
    filled.name = '受限任务';
    filled.shellCommand = 'echo ok';
    filled.maxRunBudget = '0.25';
    filled.maxRuns = '4';
    expect(buildCronJobInput(filled)).toMatchObject({ maxRunBudget: 0.25, maxRuns: 4 });

    // 空值必须送 null 而不是 undefined：JSON 传输丢 undefined 键，host 合并时会保留旧值。
    const empty = createDefaultCronJobDraft();
    empty.name = '不限任务';
    empty.shellCommand = 'echo ok';
    expect(buildCronJobInput(empty)).toMatchObject({ maxRunBudget: null, maxRuns: null });
  });

  it('cleared/cloud-dropped limits emit null that survives JSON transport (PR#2208 R4 Important)', () => {
    // 场景 a：编辑时把已设的上限清空——null 必须活着到 host，updateJob 合并才能真正清掉。
    const cleared = buildDraftFromJob(makeJob({ maxRuns: 3, maxRunBudget: 0.5 }));
    cleared.maxRuns = '';
    cleared.maxRunBudget = '';
    const clearedWire = JSON.parse(JSON.stringify(buildCronJobInput(cleared)));
    expect(clearedWire).toMatchObject({ maxRuns: null, maxRunBudget: null });

    // 场景 b：带 maxRuns 的本地任务切/复制到云端——丢弃也必须以 null 落在线上，
    // 否则缺键会被 host 从旧定义继承回来，云端校验每存必炸。
    const toCloud = { ...buildDraftFromJob(makeJob({ maxRuns: 3 })), runsOn: 'cloud' as const };
    const cloudWire = JSON.parse(JSON.stringify(buildCronJobInput(toCloud)));
    expect(cloudWire.maxRuns).toBeNull();
  });

  it('buildDraftFromJob maps an unset budget/limit to empty strings', () => {
    const draft = buildDraftFromJob(makeJob());
    expect(draft.maxRunBudget).toBe('');
    expect(draft.maxRuns).toBe('');
  });

  it('buildCronJobInput drops a hidden maxRuns for cloud jobs (PR#2208 R2 Important)', () => {
    // 复制本地任务到云端：draft 里带着来源任务的 maxRuns，但编辑面已把字段隐藏。
    const copied = { ...buildDraftFromJob(makeJob({ maxRuns: 3 })), runsOn: 'cloud' as const };
    expect(buildCronJobInput(copied).maxRuns).toBeNull();

    // 新建：先填运行次数上限再切到云端。
    const switched = createDefaultCronJobDraft();
    switched.name = '先填后切';
    switched.shellCommand = 'echo ok';
    switched.maxRuns = '5';
    switched.runsOn = 'cloud';
    expect(buildCronJobInput(switched).maxRuns).toBeNull();

    // 本地任务照常携带。
    const local = createDefaultCronJobDraft();
    local.name = '本地任务';
    local.shellCommand = 'echo ok';
    local.maxRuns = '5';
    expect(buildCronJobInput(local).maxRuns).toBe(5);
  });

  it('复制带 maxRuns 的本地任务到云端：保存时不再提交 maxRuns（PR#2208 R2 Important）', async () => {
    const createJob = vi.fn(async (_input: unknown) => makeJob());
    useCronStore.setState({ createJob });
    render(<CronJobEditor isOpen job={null} copySource={makeJob({ maxRuns: 3 })} onClose={() => undefined} />);

    fireEvent.click(screen.getByText('创建任务'));
    // 无角色任务先过保存前确认卡（N-CRON-MORNING-TRIAGE-REST1），确认才落库。
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));

    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(createJob.mock.calls[0]?.[0]).toMatchObject({ runsOn: 'cloud', maxRuns: null });
  });

  it('非法次数/预算在客户端就被拦下：buildCronJobInput 抛中文错，不把 host 英文原文放行到用户脸上（N-CRON-BUDGET-EXPOSE-SHOTS ⑤）', () => {
    for (const invalid of ['0', '1.5', '-1']) {
      const draft = createDefaultCronJobDraft();
      draft.name = '非法次数';
      draft.shellCommand = 'echo ok';
      draft.maxRuns = invalid;
      expect(() => buildCronJobInput(draft)).toThrow('运行次数上限必须是大于等于 1 的整数');
    }

    const budget = createDefaultCronJobDraft();
    budget.name = '非法预算';
    budget.shellCommand = 'echo ok';
    budget.maxRunBudget = '-1';
    expect(() => buildCronJobInput(budget)).toThrow('单次预算上限必须是大于等于 0 的数字');

    // 合法值与留空不受影响（空 = null = 不限）。
    const valid = createDefaultCronJobDraft();
    valid.name = '合法值';
    valid.shellCommand = 'echo ok';
    valid.maxRuns = '5';
    valid.maxRunBudget = '0.01';
    expect(() => buildCronJobInput(valid)).not.toThrow();
  });

  it('编辑器里保存非法次数：表单错误框给出可见中文提示，且不发出 updateJob（⑤ 的 UI 面）', async () => {
    const updateJob = vi.fn();
    useCronStore.setState({ updateJob });
    render(<CronJobEditor isOpen job={makeJob({ maxRuns: 3, maxRunBudget: 0.5 })} onClose={() => undefined} />);

    fireEvent.click(screen.getByText('高级选项'));
    fireEvent.change(screen.getByDisplayValue('3'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByText('保存修改'));

    await waitFor(() => expect(screen.getByText('运行次数上限必须是大于等于 1 的整数')).toBeTruthy());
    expect(updateJob).not.toHaveBeenCalled();
  });

  it('编辑器里保存非法预算：同款可见中文提示（⑤ 的 UI 面）', async () => {
    const updateJob = vi.fn();
    useCronStore.setState({ updateJob });
    render(<CronJobEditor isOpen job={makeJob({ maxRuns: 3, maxRunBudget: 0.5 })} onClose={() => undefined} />);

    fireEvent.click(screen.getByText('高级选项'));
    fireEvent.change(screen.getByDisplayValue('0.5'), { target: { value: '-1' } });
    fireEvent.click(screen.getByText('保存修改'));

    await waitFor(() => expect(screen.getByText('单次预算上限必须是大于等于 0 的数字')).toBeTruthy());
    expect(updateJob).not.toHaveBeenCalled();
  });

  it('非事件模板填参步骤把单次预算带进创建载荷', async () => {
    const createJob = vi.fn(async (_input: unknown) => makeJob());
    useCronStore.setState({ createJob });
    render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);

    fireEvent.click(screen.getByText('从模板创建'));
    fireEvent.click(await screen.findByText('每日前瞻'));
    fireEvent.change(screen.getByTestId('cron-budget-limit-input'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('创建任务'));
    expect(createJob).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));

    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    expect(createJob.mock.calls[0]?.[0]).toMatchObject({ maxRunBudget: 2 });
  });
});

// ============================================================================
// N-FIX-CRON-EDITOR-USD-CAP-NO-FLATFEE-NOTE（FB-1499）：编辑器高级选项的
// USD 预算字段下补上包月模型提示——与创建表单（CronRunBudgetField）同款，
// 包月模型设 0.01 上限的用户不再误以为上限真的会触发。
// ============================================================================
describe('N-FIX-CRON-EDITOR-USD-CAP-NO-FLATFEE-NOTE 编辑器高级选项的包月预算提示', () => {
  const FLAT_FEE_MODEL = 'mimo-v2.6-flash';
  const NOTE_ZH = '是包月模型，不按美元计费，美元上限对它不生效';

  it('包月模型（zh）：高级选项预算字段下显示包月提示，带模型名', () => {
    setModel('xiaomi', FLAT_FEE_MODEL, 'zh');
    openAdvancedTab(makeJob({ maxRunBudget: 0.01 }));

    const note = screen.getByTestId('flat-fee-budget-note');
    expect(note.textContent).toContain(`${FLAT_FEE_MODEL} ${NOTE_ZH}`);
    expect(note.textContent).toContain('要限制单次运行，请改用任务设置里的「执行超时」，或换成按量计费的模型');
    expect(screen.getByDisplayValue('0.01')).toBeTruthy();
  });

  it('包月模型（en）：同一句提示以英文出现', () => {
    setModel('xiaomi', FLAT_FEE_MODEL, 'en');
    openAdvancedTab(makeJob({ maxRunBudget: 0.01 }), 'en');

    const note = screen.getByTestId('flat-fee-budget-note');
    expect(note.textContent).toContain(`${FLAT_FEE_MODEL} is a flat-fee model and is not billed in USD, so the USD cap does not apply`);
  });

  it('包月模型：预算 0.01 保存并重开编辑器后提示仍在', async () => {
    setModel('xiaomi', FLAT_FEE_MODEL, 'zh');
    const updateJob = vi.fn(async (_id: string, _input: unknown) => makeJob({ maxRunBudget: 0.01 }));
    useCronStore.setState({ updateJob });

    render(<CronJobEditor isOpen job={makeJob({})} onClose={() => undefined} />);
    fireEvent.click(screen.getByText('高级选项'));
    fireEvent.change(screen.getByTestId('cron-budget-limit-input'), { target: { value: '0.01' } });
    fireEvent.click(screen.getByText('保存修改'));
    // 无角色任务先过保存前确认卡（N-CRON-MORNING-TRIAGE-REST1）。
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));

    await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1));
    expect(updateJob.mock.calls[0]?.[1]).toMatchObject({ maxRunBudget: 0.01 });
    cleanup();

    // 重开编辑器：列表刷新后带回的 job 对象（maxRunBudget 已落库）。
    render(<CronJobEditor isOpen job={makeJob({ maxRunBudget: 0.01 })} onClose={() => undefined} />);
    fireEvent.click(screen.getByText('高级选项'));
    expect(screen.getByDisplayValue('0.01')).toBeTruthy();
    expect(screen.getByTestId('flat-fee-budget-note').textContent).toContain(`${FLAT_FEE_MODEL} ${NOTE_ZH}`);
  });

  it('按量计费模型：高级选项不显示包月提示', () => {
    setModel('zhipu', 'glm-5.3', 'zh');
    openAdvancedTab(makeJob({ maxRunBudget: 0.01 }));

    expect(screen.queryByTestId('flat-fee-budget-note')).toBeNull();
    expect(screen.getByTestId('cron-budget-limit-input')).toBeTruthy();
  });

  it('event 任务：高级选项同样显示包月提示', () => {
    setModel('xiaomi', FLAT_FEE_MODEL, 'zh');
    openAdvancedTab(makeJob({
      scheduleType: 'event',
      schedule: { type: 'event', source: 'channel', accountId: 'account-x', eventName: 'message' },
      action: { type: 'agent', agentType: 'default', prompt: '处理新消息' },
      maxRunBudget: 1,
    }));

    expect(screen.getByTestId('cron-budget-limit-input')).toBeTruthy();
    expect(screen.getByTestId('flat-fee-budget-note').textContent).toContain(`${FLAT_FEE_MODEL} ${NOTE_ZH}`);
  });

  it('webhook 任务：编辑器里显示包月提示（基本设置与高级选项）', () => {
    setModel('xiaomi', FLAT_FEE_MODEL, 'zh');
    // 落库态 scheduleType 只有 'event'（webhook 分型由 buildDraftFromJob 按 schedule.source 推导）。
    render(<CronJobEditor isOpen job={makeJob({
      scheduleType: 'event',
      schedule: { type: 'event', source: 'webhook', eventName: 'message' },
      action: { type: 'agent', agentType: 'default', prompt: '处理新消息' },
      maxRunBudget: 1,
    })} onClose={() => undefined} />);

    // 基本设置里 webhook 字段自带同款提示（既有行为）。
    expect(screen.getAllByTestId('flat-fee-budget-note').length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByText('高级选项'));
    expect(screen.getByTestId('cron-budget-limit-input')).toBeTruthy();
    expect(screen.getByTestId('flat-fee-budget-note').textContent).toContain(`${FLAT_FEE_MODEL} ${NOTE_ZH}`);
  });

  it('cloud 任务：预算字段与包月提示都不显示（行为不变）', () => {
    setModel('xiaomi', FLAT_FEE_MODEL, 'zh');
    openAdvancedTab(makeJob({ runsOn: 'cloud', schedule: { type: 'every', interval: 2, unit: 'hours' } }));

    expect(screen.queryByText('单次预算上限 (USD)')).toBeNull();
    expect(screen.queryByTestId('flat-fee-budget-note')).toBeNull();
  });
});
