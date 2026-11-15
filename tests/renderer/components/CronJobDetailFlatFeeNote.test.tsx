// @vitest-environment jsdom
// N-FIX-CRON-ZERO-PRICE-BUDGET-SUMMARY-NO-HINT：任务详情里的包月预算提示（真实 CronJobDetail）。
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
import type { ModelConfig } from '../../../src/shared/contract/model';

const MODEL = 'mimo-v2.6-flash';
const COPY = {
  zh: '当前模型按月计费，不按美元计费，美元上限不会触发',
  en: 'The current model is billed monthly, not in USD, so a USD cap will not trigger',
} as const;

function setModel(provider: string, model: string, language: 'zh' | 'en') {
  const base = useAppStore.getState().modelConfig;
  useAppStore.setState({ language, modelConfig: { ...base, provider, model } as ModelConfig });
}
function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    id: 'job-1', runsOn: 'local', name: 'Morning news', scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * *' },
    action: { type: 'agent', agentType: 'general', prompt: 'Summarize three news pages' },
    enabled: true, maxRetries: 3, createdAt: 1, updatedAt: 1, ...overrides,
  };
}
afterEach(cleanup);

describe('CronJobDetail flat-fee budget note', () => {
  it.each(['zh', 'en'] as const)('maxRunBudget 0.5 on flat-fee model (%s): sentence without model id', (language) => {
    setModel('xiaomi', MODEL, language);
    render(<CronJobDetail job={makeJob({ maxRunBudget: 0.5 })} />);
    const note = screen.getByTestId('flat-fee-budget-note-center');
    expect(note.textContent).toContain(COPY[language]);
    expect(note.textContent).not.toContain(MODEL);
  });

  it('empty maxRunBudget or pay-per-use model: nothing', () => {
    setModel('xiaomi', MODEL, 'zh');
    render(<CronJobDetail job={makeJob({})} />);
    expect(screen.queryByTestId('flat-fee-budget-note-center')).toBeNull();
    cleanup();
    setModel('zhipu', 'glm-5.3', 'zh');
    render(<CronJobDetail job={makeJob({ maxRunBudget: 0.5 })} />);
    expect(screen.queryByTestId('flat-fee-budget-note-center')).toBeNull();
  });
});
