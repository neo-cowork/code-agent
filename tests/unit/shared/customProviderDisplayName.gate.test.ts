import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProvider, ModelProviderSettings, TaskModelStrategySettings } from '../../../src/shared/contract';
import {
  buildProviderInfoFromSettings,
  buildRuntimeModelOptions,
  groupRuntimeModelOptionsByProvider,
} from '../../../src/shared/modelRuntime';
import { deriveBridgedVisualModels } from '../../../src/shared/visualModelBridge';
import { resolveProviderLabel } from '../../../src/renderer/i18n/providerDisplay';
import { getProviderDisplayName } from '../../../src/renderer/i18n/settingsVocabulary';
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

const RAW_CUSTOM_ID = /custom-/i;

describe('customProviderDisplayName gate: no provider-name exit leaks custom-* for unnamed providers', () => {
  for (const language of ['zh', 'en'] as const) {
    it(`all provider-name exits are free of custom-* in ${language}`, () => {
      useAppStore.setState({ language, cloudUIStrings: null });

      for (const providerId of UNNAMED_IDS) {
        const cfg = PROVIDERS_FIXTURE[providerId]!;
        const info = buildProviderInfoFromSettings(providerId, cfg);
        expect(info?.name, `buildProviderInfoFromSettings(${providerId})`).not.toMatch(RAW_CUSTOM_ID);

        expect(
          getProviderDisplayName(providerId, cfg.displayName, info?.name ?? providerId, language),
          `getProviderDisplayName(${providerId}, info.name)`,
        ).not.toMatch(RAW_CUSTOM_ID);
        expect(
          getProviderDisplayName(providerId, cfg.displayName, providerId, language),
          `getProviderDisplayName(${providerId}, rawId)`,
        ).not.toMatch(RAW_CUSTOM_ID);
        expect(
          resolveProviderLabel(providerId, cfg.displayName, language),
          `resolveProviderLabel(${providerId}, configured)`,
        ).not.toMatch(RAW_CUSTOM_ID);
        expect(
          resolveProviderLabel(providerId, undefined, language),
          `resolveProviderLabel(${providerId}, undefined)`,
        ).not.toMatch(RAW_CUSTOM_ID);
      }

      const options = buildRuntimeModelOptions(SETTINGS_FIXTURE, [], { dedupeProviderGroups: false });
      for (const opt of options) {
        if (!UNNAMED_IDS.includes(opt.provider)) continue;
        expect(opt.providerLabel, `RuntimeModelOption.providerLabel(${opt.provider})`).not.toMatch(RAW_CUSTOM_ID);
        expect(opt.providerGroupLabel ?? '', `RuntimeModelOption.providerGroupLabel(${opt.provider})`).not.toMatch(RAW_CUSTOM_ID);
        expect(opt.providerSourceLabel ?? '', `RuntimeModelOption.providerSourceLabel(${opt.provider})`).not.toMatch(RAW_CUSTOM_ID);
        expect(
          resolveProviderLabel(opt.provider, opt.providerLabel, language),
          `search label (${opt.provider})`,
        ).not.toMatch(RAW_CUSTOM_ID);
        expect(
          formatModelSwitcherLabel(opt.model, opt.provider, SETTINGS_FIXTURE, options, language, opt.label),
          `formatModelSwitcherLabel(${opt.provider})`,
        ).not.toMatch(RAW_CUSTOM_ID);
      }

      const groups = groupRuntimeModelOptionsByProvider(buildRuntimeModelOptions(SETTINGS_FIXTURE));
      for (const group of groups) {
        expect(
          resolveProviderLabel(group.provider, group.providerLabel, language),
          `group title (${group.provider})`,
        ).not.toMatch(RAW_CUSTOM_ID);
      }

      for (const providerId of UNNAMED_IDS) {
        const firstModel = Object.keys(PROVIDERS_FIXTURE[providerId]?.models ?? {})[0]!;
        expect(
          formatNativeModelSwitcherTooltip({
            language,
            engineLabel: 'Neo',
            settings: SETTINGS_FIXTURE,
            currentModel: firstModel,
            displayProvider: providerId,
            displayModel: firstModel,
            adaptive: false,
            overridden: false,
          }),
          `formatNativeModelSwitcherTooltip(${providerId})`,
        ).not.toMatch(RAW_CUSTOM_ID);
      }

      const html = renderToStaticMarkup(
        React.createElement(TaskStrategySettingsPanel, {
          settings: { ...SETTINGS_FIXTURE, models: { ...SETTINGS_FIXTURE.models, taskStrategy: STRATEGY_FIXTURE } },
          providerConfigs: PROVIDERS_FIXTURE,
          defaultModel: { provider: 'custom-provider', model: 'neohorse-1.5-flash-preview' },
          config: { provider: 'custom-provider', model: 'neohorse-1.5-flash-preview' },
          strategy: STRATEGY_FIXTURE,
          onChange: vi.fn(),
          onMemoryRouteChange: vi.fn(),
        }),
      );
      const optgroupLabels = Array.from(html.matchAll(/<optgroup[^>]*\blabel="([^"]*)"/g), (match) => match[1]);
      expect(optgroupLabels.length).toBeGreaterThan(0);
      for (const label of optgroupLabels) {
        expect(label, `TaskStrategySettingsPanel optgroup (${label})`).not.toMatch(RAW_CUSTOM_ID);
      }
      const visibleText = html.replace(/<[^>]+>/g, ' ');
      expect(visibleText, 'TaskStrategySettingsPanel visible text').not.toMatch(RAW_CUSTOM_ID);

      const bridged = deriveBridgedVisualModels(SETTINGS_FIXTURE);
      for (const item of bridged) {
        if (!UNNAMED_IDS.includes(item.sourceProvider as ModelProvider)) continue;
        expect(item.sourceLabel, `deriveBridgedVisualModels(${item.sourceProvider})`).not.toMatch(RAW_CUSTOM_ID);
      }

      // Named custom provider remains untouched across exits
      const namedCfg = PROVIDERS_FIXTURE['custom-named-relay']!;
      const namedInfo = buildProviderInfoFromSettings('custom-named-relay', namedCfg);
      expect(namedInfo?.name).toBe('CommonStack Pro');
      expect(getProviderDisplayName('custom-named-relay', namedCfg.displayName, namedInfo!.name, language)).toBe('CommonStack Pro');
      expect(resolveProviderLabel('custom-named-relay', namedCfg.displayName, language)).toBe('CommonStack Pro');
    });
  }
});
