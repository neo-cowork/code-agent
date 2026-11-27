// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProvider, ModelProviderSettings, TaskModelStrategySettings } from '../../../src/shared/contract';
import {
  buildRuntimeModelOptions,
  groupRuntimeModelOptionsByProvider,
} from '../../../src/shared/modelRuntime';
import { deriveBridgedVisualModels } from '../../../src/shared/visualModelBridge';
import { resolveProviderLabel } from '../../../src/renderer/i18n/providerDisplay';
import {
  formatModelSwitcherLabel,
  formatNativeModelSwitcherTooltip,
} from '../../../src/renderer/components/StatusBar/modelSwitcherTooltips';
import { TaskStrategySettingsPanel } from '../../../src/renderer/components/features/settings/tabs/TaskStrategySettingsPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const UNNAMED_IDS: readonly ModelProvider[] = [
  'custom-commonstack-claude',
  'custom-provider',
  'custom-provider-2',
  'custom-xiaomi-ultraspeed',
];

const PROVIDERS_FIXTURE: Partial<Record<ModelProvider, ModelProviderSettings>> = {
  'custom-commonstack-claude': {
    enabled: true,
    apiKeyConfigured: true,
    baseUrl: 'https://commonstack.example/v1',
    models: {
      'claude-sonnet-4-6': { enabled: true },
      'flux-dev': { enabled: true, capabilities: ['imageGen'] },
    },
  },
  'custom-provider': {
    enabled: true,
    apiKeyConfigured: true,
    baseUrl: 'https://intranet-1.example/v1',
    models: {
      'neohorse-1.5-flash-preview': { enabled: true },
      'flux-schnell': { enabled: true, capabilities: ['imageGen'] },
    },
  },
  'custom-provider-2': {
    enabled: true,
    apiKeyConfigured: true,
    baseUrl: 'https://intranet-2.example/v1',
    models: {
      'neohorse-1.5-flash-preview': { enabled: true },
      'wanx-v1': { enabled: true, capabilities: ['imageGen'] },
    },
  },
  'custom-xiaomi-ultraspeed': {
    enabled: true,
    apiKeyConfigured: true,
    displayName: 'custom-xiaomi-ultraspeed',
    baseUrl: 'https://ultraspeed.example/v1',
    models: {
      'mimo-v2.6-flash': { enabled: true },
      'cogview-4': { enabled: true, capabilities: ['imageGen'] },
    },
  },
  'custom-named-relay': {
    enabled: true,
    apiKeyConfigured: true,
    displayName: 'CommonStack Pro',
    baseUrl: 'https://pro.commonstack.example/v1',
    models: {
      'claude-sonnet-4-6': { enabled: true },
      'mimo-v2.6-flash': { enabled: true },
      'flux-pro': { enabled: true, capabilities: ['imageGen'] },
    },
  },
};

const SETTINGS_FIXTURE = {
  models: {
    default: 'custom-provider',
    defaultProvider: 'custom-provider',
    providers: PROVIDERS_FIXTURE,
    routing: {
      fast: { provider: 'custom-provider', model: 'neohorse-1.5-flash-preview' },
    },
  },
} as unknown as AppSettings;

const STRATEGY_FIXTURE: TaskModelStrategySettings = {
  mode: 'auto',
  defaultProfile: 'main',
  profiles: {
    fast: { provider: 'custom-provider', model: 'neohorse-1.5-flash-preview', reasoningEffort: 'low', maxTokens: 4096 },
    main: { provider: 'custom-provider-2', model: 'neohorse-1.5-flash-preview', reasoningEffort: 'medium', maxTokens: 16384 },
    deep: { provider: 'custom-commonstack-claude', model: 'claude-sonnet-4-6', reasoningEffort: 'high', maxTokens: 32768 },
    vision: { provider: 'custom-xiaomi-ultraspeed', model: 'mimo-v2.6-flash', reasoningEffort: 'medium', maxTokens: 4096 },
  },
  fallback: {
    enabled: true,
    preferSameProvider: true,
    allowCrossProvider: true,
  },
  rules: [],
};

beforeEach(() => {
  useAppStore.setState({ language: 'zh', cloudUIStrings: null });
});

afterEach(() => {
  cleanup();
});

describe('customProviderLabel across switcher, tooltips, task strategy, and visual bridge', () => {
  it.each(['zh', 'en'] as const)(
    'renders human labels without custom-*, distinguishes generic custom providers, and preserves CommonStack Pro (%s)',
    (language) => {
      useAppStore.setState({ language });
      const expectedGeneric1 = language === 'zh' ? '自定义模型服务' : 'Custom provider';
      const expectedGeneric2 = language === 'zh' ? '自定义模型服务 2' : 'Custom provider 2';

      const options = buildRuntimeModelOptions(SETTINGS_FIXTURE, [], { dedupeProviderGroups: false });
      const switcherOptions = buildRuntimeModelOptions(SETTINGS_FIXTURE);
      const groups = groupRuntimeModelOptionsByProvider(switcherOptions);

      // 1. Switcher group titles
      const groupTitles = groups.map((group) => resolveProviderLabel(group.provider, group.providerLabel, language));
      for (const title of groupTitles) {
        expect(title).not.toMatch(/custom-/i);
      }
      expect(groupTitles).toContain(expectedGeneric1);
      expect(groupTitles).toContain(expectedGeneric2);
      expect(expectedGeneric1).not.toBe(expectedGeneric2);
      expect(groupTitles).toContain('CommonStack Pro');

      // 2. Search-matched labels (ModelSwitcher search path)
      const searchLabelsByProvider = new Map<ModelProvider, string>();
      for (const opt of options) {
        const label = resolveProviderLabel(opt.provider, opt.providerLabel, language);
        expect(label).not.toMatch(/custom-/i);
        searchLabelsByProvider.set(opt.provider, label);
      }
      for (const id of UNNAMED_IDS) {
        expect(resolveProviderLabel(id, PROVIDERS_FIXTURE[id]?.displayName, language)).not.toMatch(/custom-/i);
        expect(resolveProviderLabel(id, undefined, language)).not.toMatch(/custom-/i);
      }
      expect(searchLabelsByProvider.get('custom-provider')).toBe(expectedGeneric1);
      expect(searchLabelsByProvider.get('custom-provider-2')).toBe(expectedGeneric2);
      expect(searchLabelsByProvider.get('custom-provider')).not.toBe(searchLabelsByProvider.get('custom-provider-2'));
      expect(searchLabelsByProvider.get('custom-commonstack-claude')).toBe('Commonstack Claude');
      expect(searchLabelsByProvider.get('custom-xiaomi-ultraspeed')).toBe('Xiaomi Ultraspeed');
      expect(searchLabelsByProvider.get('custom-named-relay')).toBe('CommonStack Pro');

      const searchQuery = language === 'zh' ? '自定义' : 'custom provider';
      const matchedGenericProviders = switcherOptions
        .filter((opt) => resolveProviderLabel(opt.provider, opt.providerLabel, language).toLowerCase().includes(searchQuery))
        .map((opt) => opt.provider);
      expect(matchedGenericProviders).toEqual(['custom-provider', 'custom-provider-2']);

      // 3. Switcher option labels & native tooltips
      const switcherLabelGeneric1 = formatModelSwitcherLabel(
        'neohorse-1.5-flash-preview',
        'custom-provider',
        SETTINGS_FIXTURE,
        options,
        language,
      );
      const switcherLabelGeneric2 = formatModelSwitcherLabel(
        'neohorse-1.5-flash-preview',
        'custom-provider-2',
        SETTINGS_FIXTURE,
        options,
        language,
      );
      const switcherLabelNamed = formatModelSwitcherLabel(
        'claude-sonnet-4-6',
        'custom-named-relay',
        SETTINGS_FIXTURE,
        options,
        language,
      );
      expect(switcherLabelGeneric1).not.toBe(switcherLabelGeneric2);
      expect(switcherLabelNamed).toContain('CommonStack Pro');

      for (const opt of options) {
        const formatted = formatModelSwitcherLabel(opt.model, opt.provider, SETTINGS_FIXTURE, options, language, opt.label);
        expect(formatted).not.toMatch(/custom-/i);
      }

      const tooltipGeneric1 = formatNativeModelSwitcherTooltip({
        language,
        engineLabel: 'Neo',
        settings: SETTINGS_FIXTURE,
        currentModel: 'neohorse-1.5-flash-preview',
        displayProvider: 'custom-provider',
        displayModel: 'neohorse-1.5-flash-preview',
        adaptive: false,
        overridden: false,
      });
      const tooltipGeneric2 = formatNativeModelSwitcherTooltip({
        language,
        engineLabel: 'Neo',
        settings: SETTINGS_FIXTURE,
        currentModel: 'neohorse-1.5-flash-preview',
        displayProvider: 'custom-provider-2',
        displayModel: 'neohorse-1.5-flash-preview',
        adaptive: false,
        overridden: false,
      });
      const tooltipNamed = formatNativeModelSwitcherTooltip({
        language,
        engineLabel: 'Neo',
        settings: SETTINGS_FIXTURE,
        currentModel: 'claude-sonnet-4-6',
        displayProvider: 'custom-named-relay',
        displayModel: 'claude-sonnet-4-6',
        adaptive: false,
        overridden: false,
      });
      expect(tooltipGeneric1).not.toBe(tooltipGeneric2);
      expect(tooltipNamed).toContain('CommonStack Pro');

      for (const providerId of [...UNNAMED_IDS, 'custom-named-relay' as const]) {
        const firstModel = Object.keys(PROVIDERS_FIXTURE[providerId]?.models ?? {})[0]!;
        for (const overridden of [false, true]) {
          const tooltip = formatNativeModelSwitcherTooltip({
            language,
            engineLabel: 'Neo',
            settings: SETTINGS_FIXTURE,
            currentModel: firstModel,
            displayProvider: providerId,
            displayModel: firstModel,
            adaptive: false,
            overridden,
          });
          expect(tooltip).not.toMatch(/custom-/i);
        }
      }

      // 4. Rendered TaskStrategySettingsPanel
      const { container } = render(
        <TaskStrategySettingsPanel
          settings={{ ...SETTINGS_FIXTURE, models: { ...SETTINGS_FIXTURE.models, taskStrategy: STRATEGY_FIXTURE } }}
          providerConfigs={PROVIDERS_FIXTURE}
          defaultModel={{ provider: 'custom-provider', model: 'neohorse-1.5-flash-preview' }}
          config={{ provider: 'custom-provider', model: 'neohorse-1.5-flash-preview' }}
          strategy={STRATEGY_FIXTURE}
          onChange={vi.fn()}
          onMemoryRouteChange={vi.fn()}
        />,
      );
      const optgroupLabels = Array.from(
        new Set(
          Array.from(container.querySelectorAll('optgroup')).map((el) => el.getAttribute('label') ?? ''),
        ),
      );
      for (const key of optgroupLabels) {
        expect(key).not.toMatch(/custom-/i);
      }
      expect(container.textContent ?? '').not.toMatch(/custom-/i);
      expect(optgroupLabels).toContain(expectedGeneric1);
      expect(optgroupLabels).toContain(expectedGeneric2);
      expect(optgroupLabels).toContain('Commonstack Claude');
      expect(optgroupLabels).toContain('Xiaomi Ultraspeed');
      expect(optgroupLabels).toContain('CommonStack Pro');

      // 5. Visual model bridge sourceLabels
      const bridged = deriveBridgedVisualModels(SETTINGS_FIXTURE);
      expect(bridged).toHaveLength(5);
      for (const item of bridged) {
        expect(item.sourceLabel).not.toMatch(/custom-/i);
      }
      const bridgedByProvider = new Map(bridged.map((item) => [item.sourceProvider, item.sourceLabel]));
      expect(bridgedByProvider.get('custom-provider')).not.toBe(bridgedByProvider.get('custom-provider-2'));
      expect(bridgedByProvider.get('custom-named-relay')).toBe('CommonStack Pro');
    },
  );
});
