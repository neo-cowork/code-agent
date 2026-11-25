// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ModelProvider, ModelProviderSettings } from '../../../src/shared/contract';
import type { ProviderInfo } from '../../../src/shared/constants';
import { buildProviderInfoFromSettings } from '../../../src/shared/modelRuntime';
import { buildProviderManagementRows } from '../../../src/renderer/components/features/settings/tabs/ModelSettings.helpers';
import { ProviderListPanel } from '../../../src/renderer/components/features/settings/tabs/ProviderListPanel';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const baseConfig: ModelConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
};

const deepseekProvider: ProviderInfo = {
  id: 'deepseek',
  name: 'DeepSeek',
  description: 'DeepSeek API',
  models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
};

function buildRowsFor(
  providerConfigs: Partial<Record<ModelProvider, ModelProviderSettings>>,
  language: 'zh' | 'en',
) {
  const providers: ProviderInfo[] = [deepseekProvider];
  for (const [providerId, cfg] of Object.entries(providerConfigs)) {
    if (providerId === 'deepseek') continue;
    const info = buildProviderInfoFromSettings(providerId as ModelProvider, cfg);
    if (info) providers.push(info);
  }
  const labels = language === 'zh' ? zh.settings.model.helpers : en.settings.model.helpers;
  return buildProviderManagementRows({
    providers,
    config: baseConfig,
    providerConfigs,
    labels,
    language,
  });
}

beforeEach(() => {
  useAppStore.setState({
    language: 'zh',
    cloudUIStrings: null,
    modelConfig: baseConfig,
  });
});

afterEach(() => {
  cleanup();
});

describe('ProviderListPanel custom provider display name fallback', () => {
  it.each(['zh', 'en'] as const)(
    'shows readable names instead of raw custom-* ids in the expanded needs-key list and keeps id search working (%s)',
    (language) => {
      useAppStore.setState({ language });
      const listText = language === 'zh' ? zh.settings.model.list : en.settings.model.list;
      const providerConfigs: Partial<Record<ModelProvider, ModelProviderSettings>> = {
        deepseek: { enabled: true, apiKeyConfigured: true, model: 'deepseek-chat' },
        'custom-commonstack-claude': { enabled: true, model: 'claude-sonnet-4-6' },
        'custom-xiaomi-ultraspeed': {
          enabled: true,
          displayName: 'custom-xiaomi-ultraspeed',
          model: 'mimo-v2.6-flash',
        },
        'custom-stored-name': {
          enabled: true,
          displayName: 'CommonStack Claude',
          model: 'claude-sonnet-4-6',
        },
      };

      const allRows = buildRowsFor(providerConfigs, language);
      const configuredRows = allRows.filter((row) => row.id === 'deepseek');
      const unconfiguredRows = allRows.filter((row) => row.id !== 'deepseek');

      const { container } = render(
        <ProviderListPanel
          configuredRows={configuredRows}
          unconfiguredRows={unconfiguredRows}
          selectedProviderId="deepseek"
          defaultProviderId="deepseek"
          isAddingProvider={false}
          onSelect={vi.fn()}
          onOpenDoctor={vi.fn()}
        />,
      );

      const toggleButton = screen.getByRole('button', {
        name: new RegExp(`${listText.unconfiguredPrefix}3`),
      });
      fireEvent.click(toggleButton);

      expect(container.textContent).toContain('Commonstack Claude');
      expect(container.textContent).toContain('Xiaomi Ultraspeed');
      expect(container.textContent).toContain('CommonStack Claude');
      expect(container.textContent).not.toMatch(/custom-/i);

      const commonstackRow = screen.getByRole('button', { name: /Commonstack Claude/ });
      expect(commonstackRow.textContent).toContain('C');

      const searchInput = screen.getByPlaceholderText(listText.searchPlaceholder);
      fireEvent.change(searchInput, { target: { value: 'custom-commonstack' } });

      expect(container.textContent).toContain('Commonstack Claude');
      expect(container.textContent).not.toContain('Xiaomi Ultraspeed');
      expect(container.textContent).not.toMatch(/custom-/i);
    },
  );

  it('uses the exact same display name in ConfiguredRow and UnconfiguredRow for the same unnamed id and keeps id search working', () => {
    const unnamedId: ModelProvider = 'custom-commonstack-claude';
    const configuredConfig: Partial<Record<ModelProvider, ModelProviderSettings>> = {
      [unnamedId]: { enabled: true, apiKeyConfigured: true, model: 'claude-sonnet-4-6' },
    };
    const unconfiguredConfig: Partial<Record<ModelProvider, ModelProviderSettings>> = {
      [unnamedId]: { enabled: true, model: 'claude-sonnet-4-6' },
    };

    const configuredRow = buildRowsFor(configuredConfig, 'zh').find((row) => row.id === unnamedId)!;
    const unconfiguredRow = buildRowsFor(unconfiguredConfig, 'zh').find((row) => row.id === unnamedId)!;

    const { container } = render(
      <ProviderListPanel
        configuredRows={[configuredRow]}
        unconfiguredRows={[unconfiguredRow]}
        selectedProviderId="deepseek"
        isAddingProvider={false}
        onSelect={vi.fn()}
        onOpenDoctor={vi.fn()}
      />,
    );

    const toggleButton = screen.getByRole('button', {
      name: new RegExp(`${zh.settings.model.list.unconfiguredPrefix}1`),
    });
    fireEvent.click(toggleButton);

    const matchingNameSpans = screen.getAllByText('Commonstack Claude');
    expect(matchingNameSpans).toHaveLength(2);
    expect(matchingNameSpans[0].textContent).toBe(matchingNameSpans[1].textContent);
    expect(container.textContent).not.toMatch(/custom-/i);

    const searchInput = screen.getByPlaceholderText(zh.settings.model.list.searchPlaceholder);
    fireEvent.change(searchInput, { target: { value: 'custom-commonstack' } });
    expect(screen.getAllByText('Commonstack Claude')).toHaveLength(2);
    expect(container.textContent).not.toMatch(/custom-/i);
  });
});
