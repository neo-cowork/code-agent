// @vitest-environment jsdom
// N-FIX-CRON-EXEC-DETAIL-ENGINEERING-FIELDS-DEFAULT：运行记录表与运行详情默认层不露工程字段——
// ① 列表无「重试/Retries」「退出码/Exit code」表头与单元格；② 详情默认层无「重试次数/退出码」
// 标签与裸退出码，收进默认关闭的技术折叠块；③ 有重试的失败/完成运行默认层给一句人话（复数选形）；
// ④ 展开技术折叠块后两个字段值正确。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    triggerJob: vi.fn(),
  },
}));
import type { CronJobExecution } from '@shared/contract';
import { CronExecutionList } from '../../../src/renderer/components/features/cron/CronExecutionList';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const NOW = new Date(2026, 10, 16, 21, 41).getTime();

function execution(overrides: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    id: 'exec-1',
    jobId: 'job-1',
    runsOn: 'local',
    status: 'failed',
    scheduledAt: NOW,
    startedAt: NOW,
    completedAt: NOW + 90_000,
    duration: 90_000,
    retryAttempt: 2,
    exitCode: 1,
    ...overrides,
  };
}

function renderList(exec: CronJobExecution) {
  return render(
    <CronExecutionList
      executions={[exec]}
      selectedExecutionId={null}
      onSelectExecution={() => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('CronExecutionList 运行记录表默认层（①）', () => {
  it('zh：表头与行内都没有「重试」「退出码」，状态列仍是用户可见的结果', () => {
    const { container } = renderList(execution());
    const headerTexts = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headerTexts).toEqual(['状态', '计划时间', '开始时间', '耗时', '成本']);
    const rowTexts = [...container.querySelectorAll('tbody tr')].map((tr) => tr.textContent);
    console.log('[① zh] header =', JSON.stringify(headerTexts), 'row =', JSON.stringify(rowTexts));
    expect(rowTexts.join(' ')).toContain('失败');
    expect(container.textContent).not.toContain('重试');
    expect(container.textContent).not.toContain('退出码');
    // 重试次数 2 与退出码 1 不再以独立单元格出现
    const cellTexts = [...container.querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cellTexts).not.toContain('2');
    expect(cellTexts).not.toContain('1');
  });

  it('en：header has no Retries / Exit code column, status stays the user-facing result', () => {
    useAppStore.setState({ language: 'en' });
    const { container } = renderList(execution());
    const headerTexts = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headerTexts).toEqual(['Status', 'Scheduled', 'Started', 'Duration', 'Cost']);
    console.log('[① en] header =', JSON.stringify(headerTexts));
    expect([...container.querySelectorAll('tbody tr')].map((tr) => tr.textContent).join(' ')).toContain('Failed');
    expect(container.textContent).not.toContain('Retries');
    expect(container.textContent).not.toContain('Exit code');
    const cellTexts = [...container.querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cellTexts).not.toContain('2');
    expect(cellTexts).not.toContain('1');
  });
});

describe('CronExecutionDetail 默认层与技术折叠块（②④）', () => {
  it('zh：重试次数/退出码只在默认关闭的折叠块里，结果 JSON 仍在原技术块', () => {
    const { container } = render(
      <CronExecutionDetail execution={execution({ result: { summary: '周报摘要已生成' } })} />,
    );
    const technical = screen.getByTestId('cron-exec-technical-fields');
    expect(technical.tagName).toBe('DETAILS');
    expect(technical.hasAttribute('open')).toBe(false);
    // 唯一出现的两个标签都在折叠块内（getByText 多处命中会直接红）
    expect(technical.contains(screen.getByText('重试次数'))).toBe(true);
    expect(technical.contains(screen.getByText('退出码'))).toBe(true);
    console.log('[② zh] closed details =', JSON.stringify(technical.textContent));
    // 原 JSON 技术块还在
    const resultTechnical = screen.getByTestId('cron-result-technical');
    expect(resultTechnical.textContent).toContain('周报摘要已生成');
    expect(container.textContent).not.toContain('cron-exec-technical-fields');
  });

  it('en：Retry count / Exit code only inside the closed technical block', () => {
    useAppStore.setState({ language: 'en' });
    render(<CronExecutionDetail execution={execution()} />);
    const technical = screen.getByTestId('cron-exec-technical-fields');
    expect(technical.hasAttribute('open')).toBe(false);
    expect(technical.contains(screen.getByText('Retry count'))).toBe(true);
    expect(technical.contains(screen.getByText('Exit code'))).toBe(true);
    console.log('[② en] closed details =', JSON.stringify(technical.textContent));
  });

  it('④ zh：展开折叠块，两个字段值正确（重试次数 2 / 退出码 1）', () => {
    render(<CronExecutionDetail execution={execution()} />);
    const technical = screen.getByTestId('cron-exec-technical-fields');
    (technical as HTMLDetailsElement).open = true; // jsdom 不实现 details 的点击激活，直接置 open 代表展开态
    const retryCell = screen.getByText('重试次数').parentElement;
    const exitCell = screen.getByText('退出码').parentElement;
    console.log('[④ zh] expanded =', JSON.stringify(technical.textContent));
    expect(retryCell?.textContent).toContain('2');
    expect(exitCell?.textContent).toContain('1');
  });

  it('④ en：expanded block shows Retry count 2 / Exit code 1', () => {
    useAppStore.setState({ language: 'en' });
    render(<CronExecutionDetail execution={execution()} />);
    const technical = screen.getByTestId('cron-exec-technical-fields');
    (technical as HTMLDetailsElement).open = true;
    expect(screen.getByText('Retry count').parentElement?.textContent).toContain('2');
    expect(screen.getByText('Exit code').parentElement?.textContent).toContain('1');
    console.log('[④ en] expanded =', JSON.stringify(technical.textContent));
  });
});

describe('CronExecutionDetail 重试一句话（③）', () => {
  it('zh：failed ×2 → 自动重试了 2 次后仍然失败（无工程词、无退出码数字）', () => {
    render(<CronExecutionDetail execution={execution()} />);
    const note = screen.getByTestId('cron-exec-retry-note');
    console.log('[③ zh failed×2]', JSON.stringify(note.textContent));
    expect(note.textContent).toBe('自动重试了 2 次后仍然失败');
    expect(note.textContent).not.toMatch(/退出码|重试次数|Exit code|Retry count/);
    expect(note.textContent).not.toContain('1');
  });

  it('en：failed ×2 → plural sentence', () => {
    useAppStore.setState({ language: 'en' });
    render(<CronExecutionDetail execution={execution()} />);
    expect(screen.getByTestId('cron-exec-retry-note').textContent).toBe('Retried automatically 2 times, then failed');
  });

  it('en：failed ×1 → singular sentence', () => {
    useAppStore.setState({ language: 'en' });
    render(<CronExecutionDetail execution={execution({ retryAttempt: 1, exitCode: 1 })} />);
    const note = screen.getByTestId('cron-exec-retry-note');
    console.log('[③ en failed×1]', JSON.stringify(note.textContent));
    expect(note.textContent).toBe('Retried automatically 1 time, then failed');
  });

  it('zh：failed ×1 → 同一句（无复数语言 one=other）', () => {
    render(<CronExecutionDetail execution={execution({ retryAttempt: 1 })} />);
    expect(screen.getByTestId('cron-exec-retry-note').textContent).toBe('自动重试了 1 次后仍然失败');
  });

  it('en：completed ×1 → Succeeded after 1 automatic retry', () => {
    useAppStore.setState({ language: 'en' });
    render(<CronExecutionDetail execution={execution({ status: 'completed', retryAttempt: 1, exitCode: 0 })} />);
    const note = screen.getByTestId('cron-exec-retry-note');
    console.log('[③ en completed×1]', JSON.stringify(note.textContent));
    expect(note.textContent).toBe('Succeeded after 1 automatic retry');
    expect(note.textContent).not.toMatch(/Exit code|Retry count/);
  });

  it('zh：completed ×2 → 自动重试 2 次后成功', () => {
    render(<CronExecutionDetail execution={execution({ status: 'completed', retryAttempt: 2, exitCode: 0 })} />);
    expect(screen.getByTestId('cron-exec-retry-note').textContent).toBe('自动重试 2 次后成功');
  });

  it('retryAttempt=0：失败运行不显示重试句', () => {
    render(<CronExecutionDetail execution={execution({ retryAttempt: 0 })} />);
    expect(screen.queryByTestId('cron-exec-retry-note')).toBeNull();
  });

  it('running ×2：运行中不显示重试句', () => {
    render(<CronExecutionDetail execution={execution({ status: 'running' })} />);
    expect(screen.queryByTestId('cron-exec-retry-note')).toBeNull();
  });
});
