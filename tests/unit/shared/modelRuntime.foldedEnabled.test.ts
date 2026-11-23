import { describe, expect, it } from 'vitest';
import { buildRuntimeModelOptions } from '../../../src/shared/modelRuntime';
import type { AppSettings } from '../../../src/shared/contract';

function settingsWithRelays(): AppSettings {
  return {
    models: {
      default: 'custom-tokenrhythm',
      defaultProvider: 'custom-tokenrhythm',
      providers: {
        'custom-older-relay': {
          enabled: true, apiKeyConfigured: true, updatedAt: 100,
          models: { 'deepseek-chat': { enabled: true } },
        },
        'custom-tokenrhythm': {
          enabled: true, apiKeyConfigured: true, updatedAt: 200,
          model: 'deepseek-reasoner',
          models: {
            'deepseek-chat': { enabled: true },
            'deepseek-reasoner': { enabled: false },
            'deepseek-default': { label: 'Default enabled' },
          },
        },
      },
    },
  } as unknown as AppSettings;
}

describe('folded custom provider model enablement', () => {
  it('hides disabled models and keeps enabled models from the latest of two folded sources', () => {
    const options = buildRuntimeModelOptions(settingsWithRelays(), []);
    expect(options.map(({ provider, model, providerGroup }) => ({ provider, model, providerGroup }))).toEqual([
      { provider: 'custom-tokenrhythm', model: 'deepseek-chat', providerGroup: 'deepseek' },
      { provider: 'custom-tokenrhythm', model: 'deepseek-default', providerGroup: 'deepseek' },
    ]);
    expect(options.map(({ model }) => model)).not.toContain('deepseek-reasoner');
  });

  it('includeDisabledProviders only exempts the current provider, never its disabled current-session model', () => {
    const settings = settingsWithRelays();
    settings.models.providers['custom-tokenrhythm']!.enabled = false;
    const options = buildRuntimeModelOptions(settings, [], {
      includeDisabledProviders: ['custom-tokenrhythm'],
    });
    expect(options.map(({ model }) => model)).toEqual(['deepseek-chat', 'deepseek-default']);
    expect(options.every(({ provider }) => provider === 'custom-tokenrhythm')).toBe(true);
    expect(options.map(({ model }) => model)).not.toContain(settings.models.providers['custom-tokenrhythm']!.model);
  });

  it('also filters disabled models when all folded sources are requested', () => {
    const options = buildRuntimeModelOptions(settingsWithRelays(), [], { dedupeProviderGroups: false });
    expect(options.map(({ provider, model }) => [provider, model])).toEqual([
      ['custom-older-relay', 'deepseek-chat'],
      ['custom-tokenrhythm', 'deepseek-chat'],
      ['custom-tokenrhythm', 'deepseek-default'],
    ]);
  });

  it('preserves non-folded custom provider filtering, including current-provider inclusion', () => {
    const settings = {
      models: { providers: { 'custom-independent': {
        enabled: false, apiKeyConfigured: true, model: 'relay-disabled',
        models: { 'relay-enabled': { enabled: true }, 'relay-disabled': { enabled: false } },
      } } },
    } as unknown as AppSettings;
    expect(buildRuntimeModelOptions(settings, [])).toEqual([]);
    const options = buildRuntimeModelOptions(settings, [], { includeDisabledProviders: ['custom-independent'] });
    expect(options.map(({ model, providerGroup }) => [model, providerGroup])).toEqual([
      ['relay-enabled', 'custom-independent'],
    ]);
  });

  it('preserves local discovery gating and filters disabled discovered models', () => {
    const settings = {
      models: { providers: { local: {
        enabled: true, available: true,
        models: {
          'llama3.2': { enabled: true, discoveredAt: 123 },
          'qwen3:8b': { enabled: false, discoveredAt: 123 },
          'stale-local': { enabled: true },
        },
      } } },
    } as unknown as AppSettings;
    expect(buildRuntimeModelOptions(settings, ['local']).map(({ model }) => model)).toEqual(['llama3.2']);
    settings.models.providers.local!.available = false;
    expect(buildRuntimeModelOptions(settings, ['local'], { includeDisabledProviders: ['local'] })).toEqual([]);
  });
});
