// @vitest-environment jsdom
// N-FIX-ROLE-WAKE-CADENCE-NO-RECORD：role-wake 运行列表的决策标签 / 跳过人话 + 收件箱专家名徽标。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listRolesMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/rolesClient', () => ({ listRoles: () => listRolesMock() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: vi.fn() } }));
const language = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ language: language.value, t: language.value === 'zh' ? zh : en }) };
});

import type { CronJobExecution } from '@shared/contract';
import { CronExecutionList } from '../../../src/renderer/components/features/cron/CronExecutionList';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { AutomationRoleChip } from '../../../src/renderer/components/features/cron/AutomationRoleChip';

const exec = (result: unknown, o: Partial<CronJobExecution> = {}): CronJobExecution => ({
  id: 'e1', jobId: 'j1', runsOn: 'local', status: 'completed', scheduledAt: 1, retryAttempt: 0, cost: 0.0123, result, ...o,
} as CronJobExecution);

beforeEach(() => { listRolesMock.mockReset(); });
afterEach(() => { cleanup(); language.value = 'zh'; });

describe('role-wake 运行列表', () => {
  it.each([
    ['advance', '推进'], ['report', '汇报'], ['suggest', '建议'], ['silence', '沉默'],
  ])('完成的唤醒显示决策标签 %s → %s，成本格仍在', (decision, label) => {
    render(<CronExecutionList executions={[exec({ roleId: 'r', trigger: 'cadence', status: 'completed', decision })]} selectedExecutionId={null} onSelectExecution={() => undefined} />);
    expect(screen.getByTestId('cron-wake-decision').textContent).toBe(label);
    expect(screen.getByTestId('cron-execution-cost-cell').textContent).not.toBe('');
  });

  it('en 标签', () => {
    language.value = 'en';
    render(<CronExecutionList executions={[exec({ roleId: 'r', trigger: 'cadence', status: 'completed', decision: 'suggest' })]} selectedExecutionId={null} onSelectExecution={() => undefined} />);
    expect(screen.getByTestId('cron-wake-decision').textContent).toBe('Suggested');
  });

  it('非角色唤醒的结果不出标签', () => {
    render(<CronExecutionList executions={[exec({ decision: 'report' })]} selectedExecutionId={null} onSelectExecution={() => undefined} />);
    expect(screen.queryByTestId('cron-wake-decision')).toBeNull();
  });

  it.each([
    ['quiet_hours', '免打扰'],
    ['silent_level', '静默档'],
    ['daily_budget_exceeded (3/3)', '3/3'],
  ])('跳过原因 %s → 人话', (skipReason, fragment) => {
    render(<CronExecutionList executions={[exec({ roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason }, { cost: undefined })]} selectedExecutionId={null} onSelectExecution={() => undefined} />);
    const text = screen.getByTestId('cron-wake-skip-reason').textContent ?? '';
    expect(text).toContain(fragment);
    expect(text).not.toContain('_');
  });

  it('未知跳过原因 → 通用一句话，不露原文（列表与详情）', () => {
    const e = exec({ roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason: 'on_fire_xyz' }, { cost: undefined });
    render(<CronExecutionList executions={[e]} selectedExecutionId={null} onSelectExecution={() => undefined} />);
    expect(screen.getByTestId('cron-wake-skip-reason').textContent).toBe('未运行：本次醒来被跳过');
    cleanup();
    render(<CronExecutionDetail execution={e} />);
    expect(screen.getByTestId('cron-wake-skip-sentence').textContent).toBe('未运行：本次醒来被跳过');
    expect(screen.getByTestId('cron-wake-skip-detail').textContent).not.toContain('on_fire_xyz');
  });

  it('详情页显示本次决定', () => {
    render(<CronExecutionDetail execution={exec({ roleId: 'r', trigger: 'cadence', status: 'completed', decision: 'report' })} />);
    expect(screen.getByTestId('cron-wake-decision-label').textContent).toBe('汇报');
  });
});

describe('role-wake 跳过行状态', () => {
  it('skipped 的唤醒状态格不是「完成」，显示「未运行」（列表 + 详情）', () => {
    const e = exec({ roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason: 'daily_budget_exceeded (5/4)' }, { cost: undefined });
    render(<CronExecutionList executions={[e]} selectedExecutionId={null} onSelectExecution={() => undefined} />);
    const row = screen.getAllByRole('row')[1].textContent ?? '';
    expect(row).toContain('未运行');
    expect(row).not.toContain('完成');
    cleanup();
    render(<CronExecutionDetail execution={e} />);
    expect(document.body.textContent).toContain('未运行');
    expect(document.body.textContent).not.toContain('完成运行');
  });

  it('完成的唤醒仍是完成', () => {
    render(<CronExecutionList executions={[exec({ roleId: 'r', trigger: 'cadence', status: 'completed', decision: 'report' })]} selectedExecutionId={null} onSelectExecution={() => undefined} />);
    expect(screen.getAllByRole('row')[1].textContent).not.toContain('未运行');
  });
});

describe('AutomationRoleChip', () => {
  it('命中角色 → 显示花名', async () => {
    listRolesMock.mockResolvedValue([{ roleId: 'role-weekly', displayName: '周报小助' }]);
    render(<AutomationRoleChip roleId="role-weekly" />);
    await waitFor(() => expect(screen.getByTestId('automation-review-role-chip').textContent).toBe('周报小助'));
  });

  it('角色已删 → 回落原始 id', async () => {
    listRolesMock.mockResolvedValue([]);
    render(<AutomationRoleChip roleId="role-gone" />);
    await waitFor(() => expect(listRolesMock).toHaveBeenCalled());
    expect(screen.getByTestId('automation-review-role-chip').textContent).toBe('role-gone');
  });

  it('没有 roleId → 不渲染也不拉角色列表', () => {
    render(<AutomationRoleChip />);
    expect(screen.queryByTestId('automation-review-role-chip')).toBeNull();
    expect(listRolesMock).not.toHaveBeenCalled();
  });
});
