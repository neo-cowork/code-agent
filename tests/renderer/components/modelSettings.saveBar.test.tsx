// @vitest-environment jsdom
// 粘贴密钥并展开模型与高级后，「保存配置」落在 sticky 底栏里，徽标、未保存密钥文案和按钮同栏。
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ModelConfig } from '../../../src/shared/contract';

const settings = vi.hoisted(() => ({
  models: {
    default: 'openai',
    defaultProvider: 'openai',
    routing: {},
    providers: { openai: { enabled: true } },
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
    on: vi.fn(() => () => {}),
    invokeDomain: vi.fn(async (_domain: string, action: string) => (action === 'get' ? settings : undefined)),
  },
}));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => false,
}));

import { ModelSettings } from '../../../src/renderer/components/features/settings/tabs/ModelSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { en } from '../../../src/renderer/i18n/en';

const m = en.settings.model;

function Settings() {
  const [config, setConfig] = useState<ModelConfig>({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: '',
    temperature: 0.7,
  });
  return <ModelSettings config={config} onChange={setConfig} />;
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh', settingsModelFocus: null, settingsMemoryFocus: null });
});

describe('ModelSettings sticky save bar', () => {
  it('keeps the unsaved badge, unsaved key line, and save button inside the sticky bar after the key is pasted and Models and Advanced are expanded', async () => {
    useAppStore.setState({ language: 'en', settingsModelFocus: null, settingsMemoryFocus: null });
    const view = render(<Settings />);
    const keyInput = await waitFor(() => {
      const input = view.container.querySelector<HTMLInputElement>('input[data-model-api-key]');
      expect(input).toBeTruthy();
      return input!;
    });

    const barBefore = view.container.querySelector('[data-testid="provider-save-bar"]');
    expect(barBefore).toBeTruthy();
    expect(barBefore!.textContent).not.toContain(m.header.unsavedBadge);
    expect(barBefore!.textContent).not.toContain(m.header.apiKeyUnsaved);

    fireEvent.change(keyInput, { target: { value: 'sk-pasted-not-saved' } });
    await waitFor(() => expect(view.container.textContent).toContain(m.models.title));
    expect(view.container.textContent).not.toContain(m.models.needsApiKeyEmpty);

    const unverified = view.container.querySelector<HTMLDetailsElement>('[data-testid="provider-models-unverified"]');
    if (unverified) {
      const summary = unverified.querySelector('summary');
      expect(summary).toBeTruthy();
      fireEvent.click(summary!);
      expect(unverified.open).toBe(true);
    }

    fireEvent.click(view.getByRole('button', { name: new RegExp(m.advanced.title) }));
    expect(view.container.textContent).toContain(m.advanced.maxConcurrentLabel);

    const bar = view.container.querySelector('[data-testid="provider-save-bar"]');
    expect(bar).toBeTruthy();
    expect(bar!.className.split(/\s+/)).toEqual(expect.arrayContaining(['sticky', 'bottom-0']));
    expect(bar!.textContent).toContain(m.header.unsavedBadge);
    expect(bar!.textContent).toContain(m.header.apiKeyUnsaved);
    expect(bar!.textContent).toContain(m.header.saveHintSuffix.trim());
    const button = bar!.querySelector('button');
    expect(button).toBeTruthy();
    expect(button!.textContent).toContain(m.header.saveConfig);
    expect(view.container.querySelector('[data-model-key-status]')?.textContent).toBe(m.header.apiKeyUnsaved);
  });
});
