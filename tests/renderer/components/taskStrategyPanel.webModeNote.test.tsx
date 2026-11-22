// @vitest-environment jsdom
// Web 版「按任务自动切换」面板只读：可见说明句 + 控件 title；桌面版两者都没有。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { AppSettings, TaskModelStrategySettings } from '../../../src/shared/contract';
import { DEFAULT_MODELS } from '../../../src/shared/constants';

const webMode = vi.hoisted(() => ({ value: true }));
const lang = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => webMode.value,
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: lang.value === 'zh' ? zh : en, language: lang.value }) };
});

import { TaskStrategySettingsPanel } from '../../../src/renderer/components/features/settings/tabs/TaskStrategySettingsPanel';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const slot = (provider: string, model: string) => ({ provider, model, reasoningEffort: 'medium', maxTokens: 4096 });
const strategy = {
  mode: 'auto', defaultProfile: 'main',
  profiles: {
    fast: slot('zhipu', DEFAULT_MODELS.quick), main: slot('xiaomi', DEFAULT_MODELS.chat),
    deep: slot('deepseek', DEFAULT_MODELS.reasoning), vision: slot('xiaomi', DEFAULT_MODELS.vision),
  },
  fallback: { enabled: true, preferSameProvider: true, allowCrossProvider: true },
  rules: [],
} as unknown as TaskModelStrategySettings;
const settings = {
  models: {
    default: 'xiaomi', defaultProvider: 'xiaomi', taskStrategy: strategy,
    providers: { xiaomi: { enabled: true, apiKeyConfigured: true }, zhipu: { enabled: true, apiKeyConfigured: true }, deepseek: { enabled: true, apiKeyConfigured: true } },
    routing: { fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick } },
  },
} as unknown as AppSettings;

beforeEach(() => { webMode.value = true; });
afterEach(cleanup);

describe.each([['zh', zh], ['en', en]] as const)('TaskStrategySettingsPanel web-mode note (%s)', (language, locale) => {
  const note = locale.settings.webModeBanner.taskStrategyDesktopOnly;
  const view = () => {
    lang.value = language;
    return render(
      <TaskStrategySettingsPanel
        settings={settings}
        providerConfigs={settings.models.providers}
        defaultModel={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        config={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        strategy={strategy}
        disabled={webMode.value}
        onChange={vi.fn()}
        onMemoryRouteChange={vi.fn()}
      />,
    );
  };

  it('web: 说明句可见，开关与所有下拉禁用且 title 为说明句', () => {
    const { container } = view();
    expect(container.textContent).toContain(note);
    const controls = [...container.querySelectorAll<HTMLElement>('select, [role="switch"]')];
    expect(controls.length).toBe(6);
    for (const c of controls) {
      expect((c as HTMLButtonElement).disabled).toBe(true);
      expect(c.getAttribute('title')).toBe(note);
    }
  });

  it('desktop: 无说明句、无 title', () => {
    webMode.value = false;
    const { container } = view();
    expect(container.textContent).not.toContain(note);
    for (const c of container.querySelectorAll('select, [role="switch"]')) {
      expect(c.hasAttribute('title')).toBe(false);
    }
  });
});
