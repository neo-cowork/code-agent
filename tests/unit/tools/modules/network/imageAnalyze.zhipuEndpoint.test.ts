// image_analyze 的智谱视觉兜底：请求目标跟随设置里填的智谱 base URL（#4002 同序），
// 留空才回落默认 coding 端点。生产入口 executeImageAnalyze，只 mock 网络边界
// （global fetch）、config service 与「无其它已配置视觉模型」的候选列表。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { MODEL_API_ENDPOINTS } from '../../../../../src/shared/constants';

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

// imageAnalyze 走 services barrel，providerResolution 的 helper 走 core/configService，
// 两处都要 mock 到同一份 fake。
vi.mock('../../../../../src/host/services', () => ({
  getConfigService: () => fakeConfigService(),
}));
vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => fakeConfigService(),
}));

// 「没有其它已配置视觉模型」：候选列表为空，直达智谱兜底路径。
vi.mock('../../../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    getVisionPreflightCandidates() {
      return [] as unknown[];
    }
  },
}));

const fsm = vi.hoisted(() => ({
  accessMock: vi.fn().mockResolvedValue(undefined),
  statMock: vi.fn().mockResolvedValue({ size: 1024 * 100 }),
  readFileMock: vi.fn().mockResolvedValue(Buffer.from('img-data')),
}));

vi.mock('fs/promises', () => ({
  default: {
    access: (...args: unknown[]) => fsm.accessMock(...args),
    stat: (...args: unknown[]) => fsm.statMock(...args),
    readFile: (...args: unknown[]) => fsm.readFileMock(...args),
  },
  access: (...args: unknown[]) => fsm.accessMock(...args),
  stat: (...args: unknown[]) => fsm.statMock(...args),
  readFile: (...args: unknown[]) => fsm.readFileMock(...args),
}));

import { executeImageAnalyze } from '../../../../../src/host/tools/modules/network/imageAnalyze';

const FILLED_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4/';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/work',
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

async function captureZhipuRequest(): Promise<{ url: string; authorization: string }> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '一只橘猫' } }] }),
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await executeImageAnalyze(
    { path: '/abs/cat.png', prompt: '描述图片' },
    makeCtx(),
    allowAll,
  );

  expect(result.ok).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  console.log(`[imageAnalyze] captured request url=${url} authorization=${headers.Authorization}`);
  return { url: String(url), authorization: headers.Authorization };
}

describe('image_analyze Zhipu vision fallback endpoint', () => {
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
    // 智谱 key 只随发向同一个 host 的请求走。
    expect(authorization).toBe('Bearer zhipu-test-key');
  });

  it('falls back to the default coding endpoint when settings are blank', async () => {
    h.getSettings.mockReturnValue({});

    const { url, authorization } = await captureZhipuRequest();

    expect(url).toBe(`${MODEL_API_ENDPOINTS.zhipuCoding}/chat/completions`);
    expect(new URL(url).host).toBe('api.0ki.cn');
    expect(authorization).toBe('Bearer zhipu-test-key');
  });

  it('treats the factory paas URL saved by the settings card as blank', async () => {
    // 设置页给 provider 建卡会把出厂 paas 地址写进 baseUrl（用户只存 key 也落这值）；
    // 它不是用户自定义，跟随它会把 coding 套餐的 vision 请求打到 paas 路径 401。
    h.getSettings.mockReturnValue({
      models: { providers: { zhipu: { baseUrl: MODEL_API_ENDPOINTS.zhipu } } },
    });

    const { url, authorization } = await captureZhipuRequest();

    expect(url).toBe(`${MODEL_API_ENDPOINTS.zhipuCoding}/chat/completions`);
    expect(authorization).toBe('Bearer zhipu-test-key');
  });
});
