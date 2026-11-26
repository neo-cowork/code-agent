// brand_extract 的智谱视觉兜底：请求目标跟随设置里填的智谱 base URL，留空回落默认
// coding 端点。生产入口 extractBrandFromImage（不传 visionCall，走真实 defaultVisionCall），
// 只 mock 网络边界（global fetch）、config service 与「无其它已配置视觉模型」的候选列表。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MODEL_API_ENDPOINTS } from '../../../../src/shared/constants';

const h = vi.hoisted(() => ({
  getApiKey: vi.fn((provider: string) => (provider === 'zhipu' ? 'zhipu-test-key' : undefined)),
  getSettings: vi.fn<() => unknown>(() => ({})),
}));

const fakeConfigService = () => ({
  onSettingsUpdated: vi.fn(),
  getApiKey: h.getApiKey,
  getServiceApiKey: vi.fn(),
  getSettings: h.getSettings,
});

// brandExtract 走 services barrel，providerResolution 的 helper 走 core/configService。
vi.mock('../../../../src/host/services', () => ({
  getConfigService: () => fakeConfigService(),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => fakeConfigService(),
}));

// 「没有其它已配置视觉模型」：候选列表为空，直达智谱兜底路径。
vi.mock('../../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    getVisionPreflightCandidates() {
      return [] as unknown[];
    }
  },
}));

import { extractBrandFromImage } from '../../../../src/host/services/design/brandExtract';

const FILLED_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4/';
const DATA_URL = `data:image/png;base64,${Buffer.from('not-a-real-png').toString('base64')}`;

const BRAND_JSON = JSON.stringify({
  palette: {
    primary: '#0b3d2e', surface: '#f7f5f0', accent: '#c8a24a',
    muted: '#7a7a72', contrast: '#16140f',
  },
  fonts: { serif: 'Tiempos, Georgia, serif', sans: 'Inter, sans-serif' },
  posture: '克制',
  keep: ['留白'],
  change: [],
  doNotCopy: ['不要渐变'],
});

async function captureZhipuRequest(): Promise<{ url: string; authorization: string }> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: BRAND_JSON } }] }),
  });
  vi.stubGlobal('fetch', fetchMock);

  const draft = await extractBrandFromImage({ dataUrl: DATA_URL });
  expect(draft.tokens.palette.primary).toBe('#0b3d2e');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  console.log(`[brandExtract] captured request url=${url} authorization=${headers.Authorization}`);
  return { url: String(url), authorization: headers.Authorization };
}

describe('brand_extract Zhipu vision fallback endpoint', () => {
  beforeEach(() => {
    h.getApiKey.mockClear();
    h.getSettings.mockReset().mockReturnValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows the zhipu base URL filled in settings', async () => {
    h.getSettings.mockReturnValue({
      models: { providers: { zhipu: { baseUrl: FILLED_ZHIPU_BASE_URL } } },
    });

    const { url, authorization } = await captureZhipuRequest();

    expect(url).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
    expect(new URL(url).host).toBe('open.bigmodel.cn');
    expect(url).not.toContain('api.0ki.cn');
    expect(authorization).toBe('Bearer zhipu-test-key');
  });

  it('falls back to the default coding endpoint when settings are blank', async () => {
    h.getSettings.mockReturnValue({});

    const { url, authorization } = await captureZhipuRequest();

    expect(url).toBe(`${MODEL_API_ENDPOINTS.zhipuCoding}/chat/completions`);
    expect(new URL(url).host).toBe('api.0ki.cn');
    expect(authorization).toBe('Bearer zhipu-test-key');
  });
});
