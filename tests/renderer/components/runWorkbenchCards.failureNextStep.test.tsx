// @vitest-environment jsdom
// ============================================================================
// 右侧任务面板的后台任务失败行：一句原因 + 一句下一步 + 可展开的原始报错
// （FB-2786 markdown 报价清单 / FB-2930 余额报错带充值链接）。
// 全程经 TaskDashboardSummary 渲染，行数据由 buildLedgerTaskRecords 产出。
// ============================================================================

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskDashboardSummary } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';
import { buildLedgerTaskRecords } from '../../../src/renderer/hooks/useRunWorkbenchModel';
import { languages, type Language } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { TaskBlockedCategory } from '../../../src/shared/contract/planning';
import { BACKGROUND_TASK_DELETE_INCOMPLETE } from '../../../src/shared/constants';

const FB_2786 = [
  '对比做不下去了，问题出在 B 那份文件上。',
  '',
  '**供应商A（可正常读取）**',
  '- 螺丝 M6：0.12 元/个',
  '- 轴承 6204：8.5 元/个',
  '- 密封圈：0.9 元/个',
].join('\n');
const FB_2930 = '账户余额不足，请充值后重试。充值地址：https://tokenrhythm.studio/account/recharge';
const TYPE_ERROR = "TypeError: Cannot read properties of undefined (reading 'map')";
const ENOTFOUND = 'getaddrinfo ENOTFOUND api.example.com';

const TITLES: Record<Language, string> = { zh: '对比两份报价', en: 'Compare two quotes' };
const CATEGORIES: TaskBlockedCategory[] = [
  'network', 'rate_limit', 'permission', 'resource', 'tool', 'model', 'logic', 'handback', 'unknown',
];
const LANGUAGES: Language[] = ['zh', 'en'];

function failedTask(message: string, language: Language, overrides: Partial<Task> = {}): Task {
  return {
    id: 'agent:quotes',
    kind: 'agent_engine',
    sessionId: 'session-1',
    runId: 'run-1',
    source: 'agent_engine',
    title: TITLES[language],
    status: 'failed',
    createdAt: 100,
    updatedAt: 100,
    startedAt: 100,
    events: [],
    outputRefs: [],
    failure: { message },
    ...overrides,
  };
}

function renderRow(task: Task, language: Language, patch: (record: ReturnType<typeof buildLedgerTaskRecords>[number]) => void = () => {}) {
  useAppStore.setState({ language });
  const records = buildLedgerTaskRecords([task], 'session-1', language);
  records.forEach(patch);
  render(<TaskDashboardSummary tasks={records} run={null} />);
  return screen.getByTestId('task-record-row');
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('failed background row: category reason + matching next step', () => {
  const cases = LANGUAGES.flatMap((language) => CATEGORIES.map((category) => [language, category] as const));

  // 九个类别逐个过：原因是该类别的兜底文案，下一步恰好是该类别那一句，别的类别的句子不出现
  it.each(cases)('%s / %s', (language, category) => {
    const t = languages[language];
    const row = renderRow(failedTask(TYPE_ERROR, language), language, (record) => {
      record.resumeHintCategory = category;
      record.failureCategory = category;
    });
    expect(row.textContent).toContain(t.taskPanel.taskBlockedReason[category]);
    expect(screen.getByTestId('task-record-next-step').textContent)
      .toBe(t.backgroundPanel.failureNextStepLine.replace('{step}', t.backgroundPanel.failureNextStep[category]));
    for (const other of CATEGORIES.filter((item) => item !== category)) {
      expect(row.textContent).not.toContain(t.backgroundPanel.failureNextStep[other]);
    }
  });

  // 能从报错文本推出来的类别：原文 → buildLedgerTaskRecords → 行，不手改行数据
  it.each([
    ['network', ENOTFOUND],
    ['rate_limit', 'Request failed with status code 429'],
    ['permission', 'AxiosError: Request failed with status code 403'],
    ['resource', "ENOENT: no such file or directory, open 'quote-b.xlsx'"],
    ['tool', 'ExecError: converter stopped, exit code 2'],
    ['model', FB_2930],
    ['unknown', TYPE_ERROR],
  ] as const)('raw text lands in %s through the ledger projection', (category, raw) => {
    for (const language of LANGUAGES) {
      const t = languages[language];
      const row = renderRow(failedTask(raw, language), language);
      expect(screen.getByTestId('task-record-next-step').textContent)
        .toBe(t.backgroundPanel.failureNextStepLine.replace('{step}', t.backgroundPanel.failureNextStep[category]));
      if (!(language === 'zh' && raw === FB_2930)) {
        expect(row.textContent).toContain(t.taskPanel.taskBlockedReason[category]);
      }
      cleanup();
    }
  });
});

describe('failed background row: collapsed state hides the raw error, the toggle shows it verbatim', () => {
  const samples = [
    ['FB-2786 markdown list', FB_2786],
    ['FB-2930 balance text with URL', FB_2930],
    ['TypeError', TYPE_ERROR],
    ['ENOTFOUND', ENOTFOUND],
  ] as const;
  const cases = LANGUAGES.flatMap((language) => samples.map(([name, raw]) => [language, name, raw] as const));

  it.each(cases)('%s / %s', (language, _name, raw) => {
    const t = languages[language];
    const row = renderRow(failedTask(raw, language), language);

    // 折叠态：整行 HTML（含 title 等属性）里没有 markdown 记号、链接、异语言原文
    expect(screen.queryByTestId('task-record-raw-error')).toBeNull();
    expect(row.innerHTML).not.toContain('**');
    expect(row.innerHTML).not.toMatch(/https?:\/\/|tokenrhythm/);
    if (language === 'zh') {
      expect(row.innerHTML).not.toMatch(/TypeError|Cannot read properties|getaddrinfo|ENOTFOUND/);
    } else {
      expect(row.innerHTML).not.toMatch(/\p{Script=Han}/u);
    }
    expect(screen.getByTestId('task-record-next-step').textContent).toBeTruthy();

    const toggle = screen.getByTestId('task-record-raw-error-toggle');
    expect(toggle.textContent).toBe(t.rendererHumanPipe.toolDetails.viewRawError);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.getByTestId('task-record-raw-error').textContent).toBe(raw);
    expect(toggle.textContent).toBe(t.rendererHumanPipe.toolDetails.hideRawError);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    expect(screen.queryByTestId('task-record-raw-error')).toBeNull();
    expect(toggle.textContent).toBe(t.rendererHumanPipe.toolDetails.viewRawError);
  });

  it('zh reasons: FB-2786 keeps the first sentence, FB-2930 drops the recharge link', () => {
    const quotes = renderRow(failedTask(FB_2786, 'zh'), 'zh');
    expect(quotes.textContent).toContain('原因：对比做不下去了，问题出在 B 那份文件上。');
    expect(quotes.textContent).not.toContain('螺丝');
    cleanup();

    const balance = renderRow(failedTask(FB_2930, 'zh'), 'zh');
    expect(balance.textContent).toContain('原因：账户余额不足，请充值后重试。');
    expect(balance.textContent).toContain('下一步：稍后再试；一直不行就到「设置 → 模型」检查账号余额或换个模型');
    expect(balance.textContent).not.toContain('充值地址');
  });

  it('a short reason that already is the whole message has no toggle', () => {
    renderRow(failedTask('文件读不出来', 'zh'), 'zh');
    expect(screen.getByTestId('task-record-next-step').textContent)
      .toBe('下一步：处理好上面说的问题后，可以让我再试一次');
    expect(screen.queryByTestId('task-record-raw-error-toggle')).toBeNull();
  });
});

describe('rows outside the failure-message branch', () => {
  it('shell and delete-incomplete rows get the toggle but no category next step', () => {
    const shell = renderRow(failedTask('Process exited with code 1', 'zh', {
      id: 'shell:copy', kind: 'shell', source: 'shell',
      failure: { message: 'Process exited with code 1', exitCode: 1, reason: 'shell_command_failed' },
    }), 'zh');
    expect(shell.textContent).toContain('原因：命令未能成功完成');
    expect(shell.textContent).not.toContain('Process exited');
    expect(screen.queryByTestId('task-record-next-step')).toBeNull();
    fireEvent.click(screen.getByTestId('task-record-raw-error-toggle'));
    expect(screen.getByTestId('task-record-raw-error').textContent).toBe('Process exited with code 1');
    cleanup();

    renderRow(failedTask('rm: cannot remove export.csv', 'zh', {
      failure: { message: 'rm: cannot remove export.csv', reason: BACKGROUND_TASK_DELETE_INCOMPLETE },
    }), 'zh');
    expect(screen.queryByTestId('task-record-next-step')).toBeNull();
    fireEvent.click(screen.getByTestId('task-record-raw-error-toggle'));
    expect(screen.getByTestId('task-record-raw-error').textContent).toBe('rm: cannot remove export.csv');
  });

  it('completed and running rows show neither line', () => {
    for (const status of ['completed', 'running'] as const) {
      renderRow(failedTask('unused', 'zh', { status, failure: undefined, summary: '对比两份报价' }), 'zh');
      expect(screen.queryByTestId('task-record-next-step')).toBeNull();
      expect(screen.queryByTestId('task-record-raw-error-toggle')).toBeNull();
      cleanup();
    }
  });
});
