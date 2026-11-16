// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ModelProviderSettings } from '../../../src/shared/contract';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { ModelSettings } from '../../../src/renderer/components/features/settings/tabs/ModelSettings';

const settings = vi.hoisted(() => ({ models: { default: 'openai', routing: {}, providers: {
  openai: { enabled: true }, 'custom-meeting': { enabled: true, displayName: 'Meeting model', protocol: 'openai', model: 'meeting-model' },
} } }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn(async (_domain: string, action: string) => action === 'get' ? settings : undefined) },
}));
vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));

function Settings({ initialProvider = 'deepseek' }: { initialProvider?: ModelConfig['provider'] }) {
  const [config, setConfig] = useState<ModelConfig>({ provider: initialProvider, model: 'deepseek-chat', apiKey: '', temperature: 0.7 });
  return <ModelSettings config={config} onChange={setConfig} />;
}

beforeEach(() => useAppStore.setState({ language: 'en', settingsModelFocus: null, settingsMemoryFocus: null }));
afterEach(cleanup);

describe('ModelSettings one-shot API key focus', () => {
  it.each(['openai', 'custom-meeting'] as const)('selects provider and focuses its key once: %s', async (provider) => {
    useAppStore.getState().openModelSettings(provider);
    const nonce = useAppStore.getState().settingsModelFocus?.nonce;
    const view = render(<Settings />);
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('type')).toBe('password');
      expect(document.activeElement?.closest('[data-model-provider]')?.getAttribute('data-model-provider')).toBe(provider);
    });
    expect(useAppStore.getState().settingsModelFocus).toBeNull();
    const other = view.container.querySelector('input')!;
    act(() => other.focus());
    view.rerender(<Settings />);
    expect(document.activeElement).toBe(other);
    act(() => useAppStore.getState().openModelSettings(provider));
    expect(useAppStore.getState().settingsModelFocus?.nonce).not.toBe(nonce);
    await waitFor(() => expect(document.activeElement?.hasAttribute('data-model-api-key')).toBe(true));
    expect(useAppStore.getState().settingsModelFocus).toBeNull();
  });

  it('guide focuses the saved default provider rather than the currently edited provider', async () => {
    const view = render(<Settings initialProvider="deepseek" />);
    const guide = await waitFor(() => {
      const button = view.getByRole('button', { name: 'No API key yet? Add one here' });
      expect(button).toBeTruthy();
      return button;
    });
    fireEvent.click(guide);
    await waitFor(() => {
      expect(document.activeElement?.hasAttribute('data-model-api-key')).toBe(true);
      expect(document.activeElement?.closest('[data-model-provider]')?.getAttribute('data-model-provider')).toBe('openai');
    });
  });

  it.each([
    ['environment', 'Using the key from your environment'],
    ['account', 'Provided by your account'],
    ['saved', 'API Key saved'],
  ] as const)('renders %s source through ModelSettings and hides the guide', async (source, text) => {
    const provider = settings.models.providers.openai as ModelProviderSettings;
    Object.assign(provider, { apiKeyConfigured: true, apiKeySource: source });
    try {
      const view = render(<Settings initialProvider="openai" />);
      await waitFor(() => expect(view.container.querySelector('[data-model-key-status]')?.textContent).toBe(text));
      expect(view.container.querySelector('[data-model-key-guide]')).toBeNull();
    } finally {
      delete provider.apiKeyConfigured;
      delete provider.apiKeySource;
    }
  });

  it('clearing an unsaved key restores waiting rather than retaining a false available state', async () => {
    const view = render(<Settings initialProvider="openai" />);
    await waitFor(() => expect(view.container.querySelector('[data-model-key-guide]')).not.toBeNull());
    const input = view.container.querySelector<HTMLInputElement>('input[data-model-api-key]')!;
    fireEvent.change(input, { target: { value: 'dummy-staged-key' } });
    expect(view.container.querySelector('[data-model-key-status]')?.textContent).toBe('API Key not saved yet');
    fireEvent.change(input, { target: { value: '' } });
    expect(view.container.querySelector('[data-model-key-status]')?.textContent).toBe('Waiting for API Key');
    expect(view.container.querySelector('[data-model-key-guide]')).not.toBeNull();
  });

  it('ordinary settings navigation discards a pending model focus', () => {
    useAppStore.getState().openModelSettings('openai');
    useAppStore.getState().openSettingsTab('general');
    expect(useAppStore.getState().settingsModelFocus).toBeNull();
  });

  it.each(['deepseek', 'local'] as const)(
    'clears disabled local focus so selecting another provider is not dragged back (initial=%s)',
    async (initialProvider) => {
      useAppStore.getState().openModelSettings('local');
      const view = render(<Settings initialProvider={initialProvider} />);
      await waitFor(() => {
        expect(view.container.textContent).toContain('Needs Key · 16');
        expect(view.container.querySelector('[data-model-provider]')?.getAttribute('data-model-provider')).toBe('local');
      });
      expect(view.container.querySelector<HTMLInputElement>('input[data-model-api-key]')?.disabled).toBe(true);

      let deepseekButton = Array.from(view.container.querySelectorAll('aside button')).find((btn) =>
        btn.textContent?.includes('DeepSeek'),
      );
      if (!deepseekButton) {
        const expandToggle = view.container.querySelector<HTMLButtonElement>('aside button[title]');
        expect(expandToggle).toBeTruthy();
        fireEvent.click(expandToggle!);
        deepseekButton = Array.from(view.container.querySelectorAll('aside button')).find((btn) =>
          btn.textContent?.includes('DeepSeek'),
        );
      }
      expect(deepseekButton).toBeTruthy();
      fireEvent.click(deepseekButton!);

      expect(view.container.querySelector('[data-model-provider]')?.getAttribute('data-model-provider')).toBe('deepseek');
      expect(view.container.querySelector<HTMLInputElement>('input[data-model-api-key]')?.disabled).toBe(false);
      expect(useAppStore.getState().settingsModelFocus).toBeNull();
    },
  );

  it('closing settings clears pending settings focus across all close paths', () => {
    useAppStore.getState().openModelSettings('local');
    useAppStore.getState().setShowSettings(false);
    expect(useAppStore.getState().settingsModelFocus).toBeNull();

    useAppStore.getState().openModelSettings('local');
    useAppStore.getState().closeSettings();
    expect(useAppStore.getState().settingsModelFocus).toBeNull();

    useAppStore.getState().openModelSettings('local');
    useAppStore.setState({ settingsReturnTo: 'cronCenter' });
    useAppStore.getState().closeSettings();
    expect(useAppStore.getState().settingsModelFocus).toBeNull();

    useAppStore.getState().openModelSettings('local');
    useAppStore.setState({ settingsReturnTo: 'chat' });
    useAppStore.getState().closeSettings();
    expect(useAppStore.getState().settingsModelFocus).toBeNull();

    useAppStore.getState().openModelSettings('local');
    useAppStore.getState().openCapabilityHub('connectors');
    expect(useAppStore.getState().settingsModelFocus).toBeNull();

    useAppStore.getState().openMemorySettings({ filename: 'project.md' });
    useAppStore.getState().closeSettings();
    expect(useAppStore.getState().settingsMemoryFocus).toBeNull();
  });
});
