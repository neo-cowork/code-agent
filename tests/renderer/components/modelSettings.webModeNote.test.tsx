// @vitest-environment jsdom
// Web 版模型页只读：说明句（可见 + 按钮 title）要讲清「新增/保存/测试连接请去桌面版」。
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ModelConfig } from '../../../src/shared/contract';

const webMode = vi.hoisted(() => ({ value: true }));
const settings = vi.hoisted(() => ({ models: { default: 'openai', defaultProvider: 'openai', routing: {}, providers: {
  openai: { enabled: true },
} } }));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), on: vi.fn(() => () => {}), invokeDomain: vi.fn(async (_d: string, action: string) => action === 'get' ? settings : undefined) },
}));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => webMode.value,
}));

import { ModelSettings } from '../../../src/renderer/components/features/settings/tabs/ModelSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

function Settings() {
  const [config, setConfig] = useState<ModelConfig>({ provider: 'openai', model: 'gpt-4o', apiKey: 'k', temperature: 0.7 });
  return <ModelSettings config={config} onChange={setConfig} />;
}

beforeEach(() => { webMode.value = true; });
afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

describe.each([['zh', zh], ['en', en]] as const)('ModelSettings web-mode note (%s)', (language, locale) => {
  const note = locale.settings.webModeBanner.modelManageDesktopOnly;
  const m = locale.settings.model;
  const names = [m.list.addProvider, m.header.saveConfig, m.connection.testConnection, m.models.discover, m.list.doctor];

  async function renderReady() {
    useAppStore.setState({ language, settingsModelFocus: null, settingsMemoryFocus: null });
    const view = render(<Settings />);
    await waitFor(() => expect(view.container.querySelector('[data-model-provider]')).toBeTruthy());
    return view;
  }

  it('web: 可见说明句 + 新增/保存/测试连接/发现模型/诊断按钮禁用且 title 为说明句，横幅仍在', async () => {
    const view = await renderReady();
    expect(view.container.textContent).toContain(note);
    expect(screen.getByText(locale.settings.webModeBanner.desktopOnlyFeature)).toBeTruthy();
    for (const name of names) {
      const b = screen.getByRole('button', { name: new RegExp(name) }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.getAttribute('title')).toBe(note);
    }
  });

  it('desktop: 无说明句、无 title', async () => {
    webMode.value = false;
    const view = await renderReady();
    expect(view.container.textContent).not.toContain(note);
    for (const name of names) {
      const b = screen.getByRole('button', { name: new RegExp(name) });
      expect(b.hasAttribute('title')).toBe(false);
    }
  });
});
