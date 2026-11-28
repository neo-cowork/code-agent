// @vitest-environment jsdom
// ============================================================================
// 输入框上方后台任务面板的失败行：一句原因 + 一句下一步 + 可展开的原始报错
// （FB-2930：余额报错连同充值链接整段出现在行里）。
// 下一步与原始报错必须在「切回前台」按钮之外——点开原文不能把会话切走。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundSessionPanel } from '../../../src/renderer/components/features/background/BackgroundSessionPanel';
import { languages, type Language } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import type { BackgroundSessionInfo } from '../../../src/shared/contract/sessionState';
import { BACKGROUND_TASK_DELETE_INCOMPLETE, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';

const FB_2786 = [
  '对比做不下去了，问题出在 B 那份文件上。',
  '',
  '**供应商A（可正常读取）**',
  '- 螺丝 M6：0.12 元/个',
  '- 轴承 6204：8.5 元/个',
].join('\n');
const FB_2930 = '账户余额不足，请充值后重试。充值地址：https://tokenrhythm.studio/account/recharge';
const TYPE_ERROR = "TypeError: Cannot read properties of undefined (reading 'map')";
const ENOTFOUND = 'getaddrinfo ENOTFOUND api.example.com';

const TITLES: Record<Language, string> = { zh: '对比两份报价', en: 'Compare two quotes' };
const LANGUAGES: Language[] = ['zh', 'en'];

function backgroundTask(overrides: Partial<BackgroundSessionInfo>): BackgroundSessionInfo {
  return {
    sessionId: 's1',
    title: '长任务',
    startedAt: Date.now(),
    backgroundedAt: Date.now(),
    status: 'running',
    ...overrides,
  };
}

function renderFailedRow(completionMessage: string | undefined, language: Language, overrides: Partial<BackgroundSessionInfo> = {}) {
  useAppStore.setState({ language });
  useSessionStore.setState({
    backgroundSessions: [backgroundTask({ status: 'failed', title: TITLES[language], completionMessage, ...overrides })],
  });
  render(<BackgroundSessionPanel />);
  return screen.getByTestId('background-session-item');
}

function itemLine(): string {
  return screen.getByTestId('background-session-item-line').textContent ?? '';
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSessionStore.setState({ backgroundSessions: [] });
  useAppStore.setState({ language: 'zh' });
});

describe('failed background panel row: category reason + matching next step', () => {
  // 面板行的类别只能从报错文本推出来；logic / handback 由任务账本写入、不会出现在这条文本里，
  // 那两类的九类全表在 runWorkbenchCards.failureNextStep.test.tsx。
  const table = [
    ['network', ENOTFOUND],
    ['rate_limit', 'Request failed with status code 429'],
    ['permission', 'AxiosError: Request failed with status code 403'],
    ['resource', "ENOENT: no such file or directory, open 'quote-b.xlsx'"],
    ['tool', 'ExecError: converter stopped, exit code 2'],
    ['model', 'ProviderError: insufficient_balance'],
    ['unknown', TYPE_ERROR],
  ] as const;
  const cases = LANGUAGES.flatMap((language) => table.map(([category, raw]) => [language, category, raw] as const));

  it.each(cases)('%s / %s', (language, category, raw) => {
    const t = languages[language];
    const row = renderFailedRow(raw, language);
    expect(itemLine()).toBe(t.taskPanel.taskBlockedReason[category]);
    expect(screen.getByTestId('background-session-next-step').textContent)
      .toBe(t.backgroundPanel.failureNextStepLine.replace('{step}', t.backgroundPanel.failureNextStep[category]));
    for (const [other] of table.filter(([item]) => item !== category)) {
      expect(row.textContent).not.toContain(t.backgroundPanel.failureNextStep[other]);
    }
  });
});

describe('failed background panel row: collapsed state hides the raw error, the toggle shows it verbatim', () => {
  const samples = [
    ['FB-2786 markdown list', FB_2786],
    ['FB-2930 balance text with URL', FB_2930],
    ['TypeError', TYPE_ERROR],
    ['ENOTFOUND', ENOTFOUND],
  ] as const;
  const cases = LANGUAGES.flatMap((language) => samples.map(([name, raw]) => [language, name, raw] as const));

  it.each(cases)('%s / %s', (language, _name, raw) => {
    const t = languages[language];
    const moveToForeground = vi.spyOn(useSessionStore.getState(), 'moveToForeground').mockResolvedValue(undefined as never);
    const row = renderFailedRow(raw, language);

    // 折叠态：整行 HTML（含 aria-label 等属性）里没有 markdown 记号、链接、异语言原文。
    // 图标自带的 SVG 命名空间不是用户可见内容，先去掉再查链接。
    const html = row.innerHTML.replaceAll('xmlns="http://www.w3.org/2000/svg"', '');
    expect(screen.queryByTestId('background-session-raw-error')).toBeNull();
    expect(html).not.toContain('**');
    expect(html).not.toMatch(/https?:\/\/|tokenrhythm/);
    if (language === 'zh') {
      expect(html).not.toMatch(/TypeError|Cannot read properties|getaddrinfo|ENOTFOUND/);
    } else {
      expect(html).not.toMatch(/\p{Script=Han}/u);
    }

    const foreground = screen.getByTestId('background-session-foreground');
    const nextStep = screen.getByTestId('background-session-next-step');
    const toggle = screen.getByTestId('background-session-raw-error-toggle');
    expect(foreground.contains(nextStep)).toBe(false);
    expect(foreground.contains(toggle)).toBe(false);
    expect(toggle.textContent).toBe(t.rendererHumanPipe.toolDetails.viewRawError);

    fireEvent.click(toggle);
    const rawBlock = screen.getByTestId('background-session-raw-error');
    expect(rawBlock.textContent).toBe(raw);
    expect(foreground.contains(rawBlock)).toBe(false);
    expect(toggle.textContent).toBe(t.rendererHumanPipe.toolDetails.hideRawError);

    fireEvent.click(toggle);
    expect(screen.queryByTestId('background-session-raw-error')).toBeNull();
    // 点开/收起原文都不触发切前台
    expect(moveToForeground).not.toHaveBeenCalled();
  });

  it('zh reasons: FB-2786 keeps the first sentence, FB-2930 drops the recharge link', () => {
    renderFailedRow(FB_2786, 'zh');
    expect(itemLine()).toBe('对比做不下去了，问题出在 B 那份文件上。');
    expect(screen.getByTestId('background-session-next-step').textContent)
      .toBe('下一步：处理好上面说的问题后，可以让我再试一次');
    cleanup();

    renderFailedRow(FB_2930, 'zh');
    expect(itemLine()).toBe('账户余额不足，请充值后重试。');
    expect(screen.getByTestId('background-session-next-step').textContent)
      .toBe('下一步：稍后再试；一直不行就到「设置 → 模型」检查账号余额或换个模型');
  });

  it('en UI: Chinese raw text falls back to the category line', () => {
    renderFailedRow(FB_2930, 'en');
    expect(itemLine()).toBe('Something went wrong on the AI model side');
    expect(screen.getByTestId('background-session-next-step').textContent)
      .toBe('Next step: Try again later; if it keeps failing, check the account balance or switch models in Settings → Models');
  });

  it('a short reason that already is the whole message has a next step but no toggle', () => {
    renderFailedRow('文件读不出来', 'zh');
    expect(itemLine()).toBe('文件读不出来');
    expect(screen.getByTestId('background-session-next-step')).toBeTruthy();
    expect(screen.queryByTestId('background-session-raw-error-toggle')).toBeNull();
  });
});

describe('rows outside the failed free-text branch stay as they were', () => {
  it('stable codes and empty failures get no next step or toggle', () => {
    for (const message of [RUN_ERROR_CODE_MAX_ITERATIONS, BACKGROUND_TASK_DELETE_INCOMPLETE, undefined]) {
      renderFailedRow(message, 'zh', message === BACKGROUND_TASK_DELETE_INCOMPLETE ? { leftoverPaths: ['/tmp/exports/a.csv'] } : {});
      expect(screen.queryByTestId('background-session-next-step')).toBeNull();
      expect(screen.queryByTestId('background-session-raw-error-toggle')).toBeNull();
      cleanup();
    }
  });

  it('completed rows show the message unchanged, running rows show the timer', () => {
    renderFailedRow(FB_2930, 'zh', { status: 'completed' });
    expect(itemLine()).toBe(FB_2930);
    expect(screen.queryByTestId('background-session-next-step')).toBeNull();
    expect(screen.queryByTestId('background-session-raw-error-toggle')).toBeNull();
    cleanup();

    renderFailedRow(undefined, 'zh', { status: 'running' });
    expect(screen.queryByTestId('background-session-next-step')).toBeNull();
  });
});
