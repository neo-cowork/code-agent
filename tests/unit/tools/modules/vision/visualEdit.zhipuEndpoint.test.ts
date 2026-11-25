// visual_edit 的智谱视觉调用：请求目标跟随设置里填的智谱 base URL，留空回落默认
// coding 端点。生产入口 visualEditModule.createHandler().execute，
// 只 mock 网络边界（global fetch）与 config service。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { MODEL_API_ENDPOINTS } from '../../../../../src/shared/constants';

const h = vi.hoisted(() => ({
  getApiKey: vi.fn((provider: string) => (provider === 'zhipu' ? 'zhipu-test-key' : undefined)),
  getSettings: vi.fn<() => unknown>(() => ({})),
}));

// toolAvailability（key 查找）与 providerResolution（baseUrl 解析）都直连 core/configService。
vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getApiKey: h.getApiKey,
    getServiceApiKey: vi.fn(),
    getSettings: h.getSettings,
  }),
}));

import { visualEditModule } from '../../../../../src/host/tools/modules/vision/visualEdit';

const FILLED_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4/';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('visual_edit Zhipu vision endpoint', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-edit-zhipu-'));
    file = path.join(tmpDir, 'Component.tsx');
    await fs.writeFile(file, 'const alpha = 0;\nconst beta = 0;\n', 'utf-8');
    h.getApiKey.mockClear();
    h.getSettings.mockReset().mockReturnValue({});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function captureZhipuRequest(): Promise<{ url: string; authorization: string }> {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              old_text: 'const alpha = 0;',
              new_text: 'const alpha = 1;',
              summary: 'alpha',
            }),
          },
        }],
      }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const handler = await visualEditModule.createHandler();
    const result = await handler.execute(
      { file, line: 1, userIntent: 'alpha intent' },
      makeCtx(tmpDir),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    console.log(`[visualEdit] captured request url=${url} authorization=${headers.Authorization}`);
    return { url: String(url), authorization: headers.Authorization };
  }

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
