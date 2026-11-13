// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../../src/shared/contract';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { ModelSettings } from '../../../src/renderer/components/features/settings/tabs/ModelSettings';

const settings = vi.hoisted(() => ({ models: { default: 'openai', routing: {}, providers: {
  openai: { enabled: true }, 'custom-meeting': { enabled: true, displayName: 'Meeting model', protocol: 'openai', model: 'meeting-model' },
} } }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn(async (_domain: string, action: string) => action === 'get' ? settings : undefined) },
}));
vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));

function Settings() {
  const [config, setConfig] = useState<ModelConfig>({ provider: 'deepseek', model: 'deepseek-chat', apiKey: '', temperature: 0.7 });
  return <ModelSettings config={config} onChange={setConfig} />;
}

beforeEach(() => useAppStore.setState({ language: 'en', settingsModelFocus: null }));
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

  it('ordinary settings navigation discards a pending model focus', () => {
    useAppStore.getState().openModelSettings('openai');
    useAppStore.getState().openSettingsTab('general');
    expect(useAppStore.getState().settingsModelFocus).toBeNull();
  });
});
