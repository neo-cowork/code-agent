// ZhipuProvider 真入口：glm-5（coding 标记模型）请求落到的 host 跟随设置里填的智谱地址。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ModelConfig } from '../../../src/shared/contract';
import { ZhipuProvider } from '../../../src/host/model/providers/zhipuProvider';
import { electronFetch } from '../../../src/host/model/providers/shared';
import { MODEL_API_ENDPOINTS } from '../../../src/shared/constants';

const mockGetSettings = vi.fn<() => unknown>();
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getApiKey: vi.fn(),
    getServiceApiKey: vi.fn(),
    getSettings: mockGetSettings,
  }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({ recordSuccess: vi.fn(), recordFailure: vi.fn() }),
}));
vi.mock('../../../src/host/model/providers/shared', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/model/providers/shared')>(
    '../../../src/host/model/providers/shared',
  );
  return { ...actual, electronFetch: vi.fn() };
});

const okBody = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };

async function postedUrl(): Promise<string> {
  vi.mocked(electronFetch).mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(okBody),
    json: async () => okBody,
  } as never);
  const config = { provider: 'zhipu', model: 'glm-5', apiKey: 'test-key' } as ModelConfig;
  await new ZhipuProvider().inference(
    [{ role: 'user', content: 'hi' }], [], config, undefined, undefined, { forceNonStreaming: true },
  );
  return vi.mocked(electronFetch).mock.calls[0][0] as string;
}

describe('ZhipuProvider glm-5 request URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('follows the zhipu base URL typed in settings', async () => {
    mockGetSettings.mockReturnValue({ models: { providers: {
      zhipu: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/' },
    } } });
    expect(await postedUrl()).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
  });

  it('keeps the default coding endpoint when settings are blank', async () => {
    mockGetSettings.mockReturnValue({});
    expect(await postedUrl()).toBe(`${MODEL_API_ENDPOINTS.zhipuCoding}/chat/completions`);
  });
});
