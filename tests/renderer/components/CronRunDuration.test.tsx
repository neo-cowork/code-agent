// @vitest-environment jsdom
// N-FIX-CRON-RUN-DURATION-UNIT-MIXED：运行记录耗时统一为人话（<1s / 秒 / 分秒 / 小时分 / 天小时）。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: vi.fn() } }));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { listJobs: vi.fn(), getStats: vi.fn(), getExecutions: vi.fn(), getRecentExecutions: vi.fn(), triggerJob: vi.fn() },
}));
const language = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh, en } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ language: language.value, t: language.value === 'zh' ? zh : en }) };
});

import type { CronJobExecution } from '@shared/contract';
import { formatDuration } from '../../../src/renderer/components/features/cron/types';
import { CronExecutionList } from '../../../src/renderer/components/features/cron/CronExecutionList';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';

const H = 3_600_000;
const CASES: Array<[string, number | undefined, string, string]> = [
  ['0', 0, '0s', '0s'],
  ['1ms', 1, '<1s', '<1s'],
  ['999ms', 999, '<1s', '<1s'],
  ['1000ms', 1000, '1 秒', '1s'],
  ['20.9s', 20_900, '21 秒', '21s'],
  ['59.4s', 59_400, '59 秒', '59s'],
  ['59.9s', 59_900, '1 分', '1m'],
  ['60s', 60_000, '1 分', '1m'],
  ['65s', 65_000, '1 分 5 秒', '1m 5s'],
  ['3599s', 3_599_000, '59 分 59 秒', '59m 59s'],
  ['3600s', 3_600_000, '1 小时', '1h'],
  ['5400s', 5_400_000, '1 小时 30 分', '1h 30m'],
  ['3h20m', 12_000_000, '3 小时 20 分', '3h 20m'],
  ['25h', 25 * H, '1 天 1 小时', '1d 1h'],
  ['86478000ms', 86_478_000, '1 天', '1d'],
  ['undefined', undefined, '—', '—'],
  ['NaN', Number.NaN, '—', '—'],
  ['Infinity', Number.POSITIVE_INFINITY, '—', '—'],
  ['negative', -5, '—', '—'],
];

afterEach(() => { cleanup(); language.value = 'zh'; });

describe('formatDuration', () => {
  it.each(CASES)('%s', (_n, ms, zh, en) => {
    expect(formatDuration(ms)).toBe(zh);
    expect(formatDuration(ms, 'zh')).toBe(zh);
    expect(formatDuration(ms, 'en')).toBe(en);
  });

  it('never shows ms or a minute value above 59', () => {
    for (const ms of [1, 999, 59_900, 3_599_500, 86_478_000, 25 * H]) {
      for (const lang of ['zh', 'en'] as const) {
        const text = formatDuration(ms, lang);
        expect(text).not.toMatch(/\d\s?ms|1441/);
        const m = /(\d+)\s?(?:m|分)(?!s)/.exec(text);
        if (m) expect(Number(m[1])).toBeLessThanOrEqual(59);
      }
    }
  });
});

const exec = (duration: number): CronJobExecution => ({
  id: 'e1', jobId: 'j1', runsOn: 'local', status: 'completed', scheduledAt: 1, startedAt: 1,
  completedAt: 2, duration, retryAttempt: 0,
});

describe('duration through the components', () => {
  it.each(CASES.filter((c) => typeof c[1] === 'number' && Number.isFinite(c[1]) && c[1] >= 0))(
    'list cell and detail row show the same text: %s',
    (_n, ms, zh, en) => {
      for (const [lang, expected] of [['zh', zh], ['en', en]] as const) {
        language.value = lang;
        const list = render(
          <CronExecutionList
            executions={[exec(ms!)]}
            selectedExecutionId={null}
            onSelectExecution={() => undefined}
            jobNameById={{ j1: 'Weekly notes' }}
            runsOnByJobId={{ j1: 'local' }}
          />,
        );
        const cell = [...list.container.querySelectorAll('td')].map((td) => td.textContent).filter((x) => x === expected);
        expect(cell).toEqual([expected]);
        list.unmount();
        const detail = render(<CronExecutionDetail execution={exec(ms!)} />);
        const label = (lang === 'zh' ? '耗时' : 'Duration');
        const row = screen.getAllByText(new RegExp(`^${label}$`, 'i'))[0].parentElement;
        expect(row?.textContent).toContain(expected);
        detail.unmount();
      }
    },
  );
});
