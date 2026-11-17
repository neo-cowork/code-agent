// @vitest-environment jsdom
// 半价档说明行的资格判据跟「默认 provider」走，而不是左侧列表当前浏览的 provider。
import React, { useState } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../../src/shared/contract';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { ModelSettings } from '../../../src/renderer/components/features/settings/tabs/ModelSettings';

const settings = vi.hoisted(() => ({ models: { default: 'xiaomi', defaultProvider: 'xiaomi', routing: {}, providers: {
  openai: { enabled: true }, xiaomi: { enabled: true },
} } }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn(async (_domain: string, action: string) => action === 'get' ? settings : undefined) },
}));
vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));

function Settings({ browsing }: { browsing: ModelConfig['provider'] }) {
  const [config, setConfig] = useState<ModelConfig>({ provider: browsing, model: 'm', apiKey: '', temperature: 0.7 });
  return <ModelSettings config={config} onChange={setConfig} />;
}

beforeEach(() => useAppStore.setState({ language: 'en', settingsModelFocus: null, settingsMemoryFocus: null }));
afterEach(cleanup);

describe('ModelSettings service tier note follows the default provider', () => {
  it('default xiaomi, browsing openai: note hidden', async () => {
    settings.models.default = settings.models.defaultProvider = 'xiaomi';
    const view = render(<Settings browsing="openai" />);
    await waitFor(() => expect(view.container.querySelector('[data-model-provider]')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(view.container.textContent).not.toContain('half-price tier');
  });

  it('default openai, browsing xiaomi: note shown', async () => {
    settings.models.default = settings.models.defaultProvider = 'openai';
    const view = render(<Settings browsing="xiaomi" />);
    await waitFor(() => expect(view.container.textContent).toContain('half-price tier'));
  });
});
