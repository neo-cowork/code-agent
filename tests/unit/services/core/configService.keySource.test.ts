import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_ENV_KEY_MAP } from '../../../../src/host/services/core/configServiceInternal';
import { getCloudManagedProviderKeyId } from '../../../../src/host/services/core/configHelpers';
import { DEFAULT_SETTINGS } from '../../../../src/host/services/core/configDefaults';

const state = vi.hoisted(() => ({ dataDir: '', keys: new Map<string, string>() }));
vi.mock('dotenv', () => ({ config: vi.fn(() => ({})) }));
vi.mock('../../../../src/host/platform', () => ({
  app: { getPath: () => state.dataDir, getAppPath: () => state.dataDir, isPackaged: false },
}));
vi.mock('../../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({
    getApiKey: (id: string) => state.keys.get(id),
    setApiKey: (id: string, key: string) => state.keys.set(id, key),
    getSettingsFromKeychain: async () => null,
    saveSettingsToKeychain: async () => undefined,
  }),
}));
vi.mock('../../../../src/host/permissions/policyEngine', () => ({
  getPolicyEngine: () => ({ loadUserRules: vi.fn() }),
}));
vi.mock('../../../../src/host/model/concurrencyLimiter', () => ({ setProviderConcurrencyOverrides: vi.fn() }));
vi.mock('../../../../src/host/model/providers/shared', () => ({ setProviderProxyOverrides: vi.fn() }));

import { ConfigService } from '../../../../src/host/services/core/configService';
let service: ConfigService;
beforeEach(async () => {
  state.dataDir = await mkdtemp(join(tmpdir(), 'model-key-source-'));
  state.keys.clear();
  for (const name of [...Object.values(PROVIDER_ENV_KEY_MAP), 'KIMI_K25_API_KEY']) {
    if (name) vi.stubEnv(name, '');
  }
  service = new ConfigService();
});
afterEach(async () => {
  service.stopWatchingConfigFile();
  vi.unstubAllEnvs();
  await rm(state.dataDir, { recursive: true, force: true });
});

describe('ConfigService.getSettings credential source', () => {
  it('fresh no-key providers remain unconfigured with no source, ignoring stale metadata', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.models.providers.longcat = { enabled: true, apiKeyConfigured: true, apiKeySource: 'saved' };
    await writeFile(join(state.dataDir, 'config.json'), JSON.stringify(settings));
    await service.initialize();
    for (const config of Object.values(service.getSettings().models.providers)) {
      expect(config.apiKeyConfigured).toBe(false);
      expect(config.apiKeySource).toBeUndefined();
    }
    expect(service.getApiKey('longcat')).toBeUndefined();
  });

  it('resolves environment, account and saved in runtime priority order', async () => {
    await service.initialize();
    vi.stubEnv('LONGCAT_API_KEY', 'dummy-for-source-check');
    expect(service.getSettings().models.providers.longcat).toMatchObject({ apiKeyConfigured: true, apiKeySource: 'environment' });
    expect(service.getApiKey('longcat')).toBe('dummy-for-source-check');
    state.keys.set(getCloudManagedProviderKeyId('longcat'), 'dummy-account-key');
    expect(service.getSettings().models.providers.longcat).toMatchObject({ apiKeyConfigured: true, apiKeySource: 'account' });
    expect(service.getApiKey('longcat')).toBe('dummy-account-key');
    state.keys.set('longcat', 'dummy-saved-key');
    expect(service.getSettings().models.providers.longcat).toMatchObject({ apiKeyConfigured: true, apiKeySource: 'saved' });
    expect(service.getApiKey('longcat')).toBe('dummy-saved-key');
    expect(service.getSettings().models.providers.longcat.apiKey).toBeUndefined();
  });

  it('legacy config key migrates as saved before account or environment fallback', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.models.providers.longcat.apiKey = 'dummy-legacy-key';
    await writeFile(join(state.dataDir, 'config.json'), JSON.stringify(settings));
    state.keys.set(getCloudManagedProviderKeyId('longcat'), 'dummy-account-key');
    vi.stubEnv('LONGCAT_API_KEY', 'dummy-for-source-check');
    await service.initialize();
    expect(service.getSettings().models.providers.longcat.apiKeySource).toBe('saved');
    expect(state.keys.get('longcat')).toBe('dummy-legacy-key');
    expect(service.getApiKey('longcat')).toBe('dummy-legacy-key');
  });

  it('moonshot alias uses environment and loses to its primary variable', async () => {
    await service.initialize();
    vi.stubEnv('KIMI_K25_API_KEY', 'dummy-alias-key');
    expect(service.getSettings().models.providers.moonshot.apiKeySource).toBe('environment');
    expect(service.getApiKey('moonshot')).toBe('dummy-alias-key');
    vi.stubEnv('MOONSHOT_API_KEY', 'dummy-primary-key');
    expect(service.getApiKey('moonshot')).toBe('dummy-primary-key');
  });

  it('dynamic managed provider key is attributed to the account', async () => {
    await service.initialize();
    await service.reconcileManagedProviders([{
      id: 'custom-account', displayName: 'Account model', baseUrl: 'https://example.test/v1',
      protocol: 'openai', apiKey: 'dummy-managed-key', billingMode: 'unknown', models: [{ id: 'account-model' }],
    }]);
    expect(service.getSettings().models.providers['custom-account']).toMatchObject({ apiKeyConfigured: true, apiKeySource: 'account' });
    expect(service.getSettings().models.providers['custom-account'].apiKey).toBeUndefined();
  });
});
