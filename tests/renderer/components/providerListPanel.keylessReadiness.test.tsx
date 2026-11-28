// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ModelProvider, ModelProviderSettings } from '../../../src/shared/contract';
import type { ProviderInfo } from '../../../src/shared/constants';
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

const localProvider: ProviderInfo = {
  id: 'local',
  name: 'Local (Ollama)',
  description: 'Local Ollama',
  models: [{ id: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B' }],
};

function buildRows(language: 'zh' | 'en', includeKeyed = true) {
  const providers: ProviderInfo[] = includeKeyed ? [deepseekProvider, localProvider] : [localProvider];
  const providerConfigs: Partial<Record<ModelProvider, ModelProviderSettings>> = {
    ...(includeKeyed ? { deepseek: { enabled: true, apiKeyConfigured: true, model: 'deepseek-chat' } } : {}),
    local: { enabled: true, model: 'qwen2.5-coder:7b' },
  };
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

describe('ProviderListPanel keyless readiness grouping', () => {
  it.each(['zh', 'en'] as const)(
    'places unreachable local provider under Not ready instead of Available (%s)',
    (language) => {
      useAppStore.setState({ language });
      const listText = language === 'zh' ? zh.settings.model.list : en.settings.model.list;
      const helperText = language === 'zh' ? zh.settings.model.helpers : en.settings.model.helpers;
      const configuredRows = buildRows(language, true);

      const { container } = render(
        <ProviderListPanel
          configuredRows={configuredRows}
          unconfiguredRows={[]}
          keylessReachability={{ local: false }}
          selectedProviderId="deepseek"
          defaultProviderId="deepseek"
          isAddingProvider={false}
          onSelect={vi.fn()}
          onOpenDoctor={vi.fn()}
        />,
      );

      const availableSection = container.querySelector('[data-provider-group="available"]');
      const notReadySection = container.querySelector('[data-provider-group="not-ready"]');
      expect(availableSection).not.toBeNull();
      expect(notReadySection).not.toBeNull();

      expect(availableSection?.textContent).toContain(`${listText.configuredPrefix}1`);
      expect(availableSection?.textContent).toContain('DeepSeek');
      expect(availableSection?.textContent).not.toContain('Ollama');
      expect(availableSection?.textContent).not.toContain(helperText.keylessUnavailable);

      expect(notReadySection?.textContent).toContain(`${listText.notReadyPrefix}1`);
      expect(notReadySection?.textContent).toContain('Ollama');
      expect(notReadySection?.textContent).toContain(helperText.keylessUnavailable);
      expect(notReadySection?.textContent).toContain(listText.ollamaUnavailableHint);
      expect(notReadySection?.textContent).not.toContain(listText.configuredPrefix);
    },
  );

  it.each(['zh', 'en'] as const)(
    'keeps probing (undefined) local provider out of Available and under Not ready (%s)',
    (language) => {
      useAppStore.setState({ language });
      const listText = language === 'zh' ? zh.settings.model.list : en.settings.model.list;
      const helperText = language === 'zh' ? zh.settings.model.helpers : en.settings.model.helpers;
      const configuredRows = buildRows(language, true);

      const { container } = render(
        <ProviderListPanel
          configuredRows={configuredRows}
          unconfiguredRows={[]}
          keylessReachability={{}}
          selectedProviderId="deepseek"
          isAddingProvider={false}
          onSelect={vi.fn()}
          onOpenDoctor={vi.fn()}
        />,
      );

      const availableSection = container.querySelector('[data-provider-group="available"]');
      const notReadySection = container.querySelector('[data-provider-group="not-ready"]');
      expect(availableSection?.textContent).toContain(`${listText.configuredPrefix}1`);
      expect(availableSection?.textContent).not.toContain('Ollama');
      expect(availableSection?.textContent).not.toContain(helperText.keylessChecking);

      expect(notReadySection?.textContent).toContain(`${listText.notReadyPrefix}1`);
      expect(notReadySection?.textContent).toContain('Ollama');
      expect(notReadySection?.textContent).toContain(helperText.keylessChecking);
    },
  );

  it.each(['zh', 'en'] as const)(
    'places reachable (true) local provider under Available and hides Not ready (%s)',
    (language) => {
      useAppStore.setState({ language });
      const listText = language === 'zh' ? zh.settings.model.list : en.settings.model.list;
      const helperText = language === 'zh' ? zh.settings.model.helpers : en.settings.model.helpers;
      const configuredRows = buildRows(language, true);

      const { container } = render(
        <ProviderListPanel
          configuredRows={configuredRows}
          unconfiguredRows={[]}
          keylessReachability={{ local: true }}
          selectedProviderId="local"
          isAddingProvider={false}
          onSelect={vi.fn()}
          onOpenDoctor={vi.fn()}
        />,
      );

      const availableSection = container.querySelector('[data-provider-group="available"]');
      const notReadySection = container.querySelector('[data-provider-group="not-ready"]');
      expect(notReadySection).toBeNull();
      expect(container.textContent).not.toContain(listText.notReadyPrefix);

      expect(availableSection?.textContent).toContain(`${listText.configuredPrefix}2`);
      expect(availableSection?.textContent).toContain('DeepSeek');
      expect(availableSection?.textContent).toContain('Ollama');
      expect(availableSection?.textContent).toContain(helperText.keylessRunning);
    },
  );

  it.each(['zh', 'en'] as const)(
    'shows configuredEmpty when no provider is ready, and switches to noMatch while searching (%s)',
    (language) => {
      useAppStore.setState({ language });
      const listText = language === 'zh' ? zh.settings.model.list : en.settings.model.list;
      const configuredRows = buildRows(language, false);

      const { container } = render(
        <ProviderListPanel
          configuredRows={configuredRows}
          unconfiguredRows={[]}
          keylessReachability={{ local: false }}
          selectedProviderId="local"
          isAddingProvider={false}
          onSelect={vi.fn()}
          onOpenDoctor={vi.fn()}
        />,
      );

      const availableSection = container.querySelector('[data-provider-group="available"]');
      const notReadySection = container.querySelector('[data-provider-group="not-ready"]');
      expect(availableSection?.textContent).toContain(`${listText.configuredPrefix}0`);
      expect(availableSection?.textContent).toContain(listText.configuredEmpty);
      expect(availableSection?.textContent).not.toContain(listText.noMatch);
      expect(notReadySection?.textContent).toContain(`${listText.notReadyPrefix}1`);

      const searchInput = screen.getByPlaceholderText(listText.searchPlaceholder);
      fireEvent.change(searchInput, { target: { value: 'does-not-exist' } });

      expect(availableSection?.textContent).toContain(listText.noMatch);
      expect(availableSection?.textContent).not.toContain(listText.configuredEmpty);
      expect(container.querySelector('[data-provider-group="not-ready"]')).toBeNull();
    },
  );
});
