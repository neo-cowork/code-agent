import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCTOR_PROBE_REAL_SUCCESS_MAX_AGE_MS } from '../../../src/shared/constants/doctor';
import { PROVIDER_REGISTRY } from '../../../src/shared/constants';
import type { ModelProviderSettings } from '../../../src/shared/contract';

const config = vi.hoisted(() => ({
  getApiKey: vi.fn(),
  getSettings: vi.fn(),
}));
vi.mock('../../../src/host/services/core/configService', () => ({ getConfigService: () => config }));

// Only redirect the built-in address to the local default path. The production
// connection test still builds the request and performs real HTTP for both paths.
vi.mock('../../../src/shared/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shared/constants')>();
  return {
    ...actual,
    getProviderEndpointForProtocol: (provider: string, protocol: Parameters<typeof actual.getProviderEndpointForProtocol>[1]) =>
      provider === 'xiaomi' || provider === 'claude' ? `${origin}/default` : actual.getProviderEndpointForProtocol(provider, protocol),
  };
});

import { checkProviderConnectivity } from '../../../src/host/diagnostics/checks/network';
import { getProviderHealthMonitor } from '../../../src/host/model/providerHealthMonitor';

let server: Server;
let origin = '';
let requests: Array<{ path: string; authorization?: string; apiKey?: string; method?: string }>;
let probeStatus: number;
let providerSettings: ModelProviderSettings;

beforeEach(async () => {
  vi.restoreAllMocks();
  requests = [];
  probeStatus = 200;
  server = createServer((req, res) => {
    requests.push({ path: req.url!, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined, method: req.method });
    res.writeHead(req.url?.startsWith('/configured/') ? probeStatus : 401, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP stub address');
  origin = `http://127.0.0.1:${address.port}`;
  providerSettings = { enabled: true, baseUrl: `${origin}/configured/`, protocol: 'openai' };
  config.getSettings.mockImplementation(() => ({ models: { providers: { xiaomi: providerSettings } } }));
  config.getApiKey.mockImplementation((provider: string) => provider === 'xiaomi' ? 'test-configured-key' : undefined);
  vi.spyOn(getProviderHealthMonitor(), 'getHealth').mockReturnValue(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

async function xiaomiItem() {
  return (await checkProviderConnectivity()).find((item) => item.name === PROVIDER_REGISTRY.xiaomi.displayName);
}

describe('checkProviderConnectivity (production connection test + local HTTP)', () => {
  it('uses the configured xiaomi endpoint and key instead of the default 401 path', async () => {
    vi.stubEnv('XIAOMI_API_KEY', 'test-env-key-must-not-win');
    expect(await xiaomiItem()).toMatchObject({ category: 'network', status: 'pass' });
    expect(requests).toEqual([{ path: '/configured/models', authorization: 'Bearer test-configured-key', method: 'GET', apiKey: undefined }]);
  });

  it('passes the configured protocol as well as the endpoint', async () => {
    providerSettings.protocol = 'claude';
    expect(await xiaomiItem()).toMatchObject({ status: 'pass' });
    expect(requests).toEqual([{ path: '/configured/messages', apiKey: 'test-configured-key', method: 'POST', authorization: undefined }]);
  });

  it('uses the configured endpoint for native Claude as well', async () => {
    providerSettings.protocol = 'claude';
    config.getSettings.mockReturnValue({ models: { providers: { claude: providerSettings } } });
    config.getApiKey.mockImplementation((provider: string) => provider === 'claude' ? 'test-configured-key' : undefined);
    const item = (await checkProviderConnectivity()).find((entry) => entry.name === PROVIDER_REGISTRY.claude.displayName);
    expect(item).toMatchObject({ status: 'pass' });
    expect(requests).toEqual([{ path: '/configured/messages', apiKey: 'test-configured-key', method: 'POST', authorization: undefined }]);
  });

  it.each([401, 403] as const)('warns on probe %i after a recent real success, without a key-fix action', async (status) => {
    probeStatus = status;
    const monitor = getProviderHealthMonitor();
    // Exercise the actual monitor observation path; no mock success counters.
    vi.mocked(monitor.getHealth).mockRestore();
    monitor.recordSuccess('xiaomi', 12);
    const item = await xiaomiItem();
    expect(monitor.getObservationCount('xiaomi')).toBeGreaterThan(0);
    expect(item).toMatchObject({ status: 'warn', probeHttpStatus: status });
    expect(item?.message).toContain(`test address returned ${status}`);
    expect(item?.details).toContain('recent real calls succeeded');
    expect(item?.details).toContain('test path may differ');
    expect(item?.fix).toBeUndefined();
    expect(item?.suggestion).toBeUndefined();
  });

  it.each([401, 403] as const)('keeps probe %i a failure without any real success', async (status) => {
    probeStatus = status;
    expect(await xiaomiItem()).toMatchObject({ status: 'fail', fix: { code: 'open-provider-settings' } });
  });

  it('does not accept old successes or failure-only observations as recent success', async () => {
    probeStatus = 401;
    const monitor = getProviderHealthMonitor();
    vi.mocked(monitor.getHealth).mockRestore();
    monitor.recordSuccess('xiaomi', 12);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + DOCTOR_PROBE_REAL_SUCCESS_MAX_AGE_MS + 1);
    expect(await xiaomiItem()).toMatchObject({ status: 'fail' });
    vi.spyOn(monitor, 'getHealth').mockReturnValue({
      provider: 'xiaomi', status: 'unavailable', latencyP50: 0, latencyP95: 0,
      errorRate: 1, lastSuccessAt: 0, lastErrorAt: now, consecutiveErrors: 1,
    });
    expect(await xiaomiItem()).toMatchObject({ status: 'fail' });
  });

  it('skips providers without a key and makes no probe request', async () => {
    config.getApiKey.mockReturnValue(undefined);
    vi.stubEnv('XIAOMI_API_KEY', '');
    const items = await checkProviderConnectivity();
    expect(items.find((item) => item.name === PROVIDER_REGISTRY.xiaomi.displayName)).toMatchObject({ status: 'skip' });
    expect(requests).toEqual([]);
  });
});
