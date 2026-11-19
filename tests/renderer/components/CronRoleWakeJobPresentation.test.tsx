// @vitest-environment jsdom
// N-FIX-ROLE-WAKE-CADENCE-NO-RECORD r1：专家定时醒来任务页不露内部名（真实 CronJobDetail）。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    getGroupListenCheck: vi.fn().mockResolvedValue({ status: 'idle' }),
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
  },
}));

import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function setLanguage(language: 'zh' | 'en') { useAppStore.setState({ language }); }
function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    id: 'job-1', runsOn: 'local', name: 'Morning news', scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * *' },
    action: { type: 'agent', agentType: 'general', prompt: 'Summarize three news pages' },
    enabled: true, maxRetries: 3, createdAt: 1, updatedAt: 1, ...overrides,
  };
}
afterEach(cleanup);

const roleWakeJob = () => makeJob({
  name: '[Cadence] 周报小助手',
  description: '角色主动性：周报小助手 定时醒来巡检（内部文档）',
  action: { type: 'role-wake', roleId: '周报小助手' } as CronJobDefinition['action'],
  tags: ['role-cadence'],
});

describe('专家定时醒来任务页（旧任务存的描述也不露内部名）', () => {
  it.each(['zh', 'en'] as const)('%s：不出现 role-wake / role-cadence / 内部文档', (language) => {
    setLanguage(language);
    render(<CronJobDetail job={roleWakeJob()} />);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('role-wake');
    expect(text).not.toContain('role-cadence');
    expect(text).not.toContain('内部文档');
    expect(text).not.toContain('角色主动性');
    expect(screen.getByTestId('cron-detail-action').textContent).toContain(language === 'zh' ? '专家定时醒来' : 'Expert check-in');
  });

  it('用户自己改过的描述原样保留', () => {
    setLanguage('zh');
    render(<CronJobDetail job={{ ...roleWakeJob(), description: '每天早上看一眼周报' }} />);
    expect(document.body.textContent).toContain('每天早上看一眼周报');
  });
});

