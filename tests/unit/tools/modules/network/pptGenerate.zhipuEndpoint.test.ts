// ppt_generate VLM 审查回调：请求目标跟随设置里填的智谱 base URL，留空回落默认
// coding 端点。生产入口 executePptGenerate（真实 VLM 回调经 reviewPresentation 注入），
// 只 mock 网络边界（https.request）、config service 与 LibreOffice 可用性。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { MODEL_API_ENDPOINTS } from '../../../../../src/shared/constants';

const h = vi.hoisted(() => ({
  getSettings: vi.fn<() => unknown>(() => ({})),
  httpsRequest: vi.fn(),
  httpRequest: vi.fn(),
  reviewPresentation: vi.fn(),
}));

vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getApiKey: vi.fn(),
    getServiceApiKey: vi.fn(),
    getSettings: h.getSettings,
  }),
}));

// 不真跑 LibreOffice：reviewPresentation 只负责把 ppt_generate 注入的 VLM 回调
// 真实调起来一次（带一张真实存在的截图文件）。
vi.mock('../../../../../src/host/tools/media/ppt/visualReview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/host/tools/media/ppt/visualReview')>();
  return {
    ...actual,
    isLibreOfficeAvailable: () => true,
    reviewPresentation: (...args: unknown[]) => h.reviewPresentation(...args),
  };
});

vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  return {
    ...actual,
    request: (...args: unknown[]) => h.httpsRequest(...args),
  };
});

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return {
    ...actual,
    request: (...args: unknown[]) => h.httpRequest(...args),
  };
});

import { executePptGenerate } from '../../../../../src/host/tools/modules/network/pptGenerate';

const FILLED_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4/';
const ENV_FLAG = 'ENABLE_LEGACY_PPT_GENERATE';
const ENV_KEY = 'ZHIPU_API_KEY';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    modelCallback: vi.fn().mockResolvedValue('ok'),
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

interface CapturedRequest {
  transport: 'http' | 'https';
  hostname: string;
  port: string | number;
  path: string;
  authorization: string;
}

describe('ppt_generate VLM callback endpoint', () => {
  let dir: string;
  let slideImage: string;
  let savedFlag: string | undefined;
  let savedKey: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-zhipu-'));
    slideImage = join(dir, 'slide.png');
    await writeFile(slideImage, Buffer.from('not-a-real-png'));
    savedFlag = process.env[ENV_FLAG];
    savedKey = process.env[ENV_KEY];
    process.env[ENV_FLAG] = '1';
    process.env[ENV_KEY] = 'zhipu-test-key';
    h.getSettings.mockReset().mockReturnValue({});
    h.httpsRequest.mockReset();
    h.httpRequest.mockReset();
    h.reviewPresentation.mockReset();
  });

  afterEach(async () => {
    if (savedFlag === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = savedFlag;
    if (savedKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedKey;
    await rm(dir, { recursive: true, force: true });
  });

  // reviewPresentation 真实触发注入的 VLM 回调；https.request 捕获请求目标，
  // 并以假 res 回一段合法 JSON 让回调 resolve。
  async function captureVlmRequest(): Promise<CapturedRequest> {
    h.reviewPresentation.mockImplementation(
      async (_pptxPath: string, _modelCb: unknown, vlm?: (p: string, img: string) => Promise<string>) => {
        if (vlm) await vlm('检查这一页', slideImage);
        return [];
      },
    );

    const captured: CapturedRequest[] = [];
    const fakeTransport = (transport: 'http' | 'https') => (
      options: { hostname: string; port: string | number; path: string; headers: Record<string, string> },
      cb: (res: unknown) => void,
    ) => {
      captured.push({
        transport,
        hostname: options.hostname,
        port: options.port,
        path: options.path,
        authorization: options.headers.Authorization,
      });
      const resHandlers: Record<string, (arg?: Buffer) => void> = {};
      const res = {
        statusCode: 200,
        on: (event: string, fn: (arg?: Buffer) => void) => {
          resHandlers[event] = fn;
          return res;
        },
      };
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn().mockReturnThis(),
        destroy: vi.fn(),
        end: vi.fn(() => {
          cb(res);
          resHandlers.data?.(Buffer.from(JSON.stringify({ choices: [{ message: { content: 'vlm ok' } }] })));
          resHandlers.end?.();
        }),
      };
    };
    h.httpsRequest.mockImplementation(fakeTransport('https'));
    h.httpRequest.mockImplementation(fakeTransport('http'));

    const result = await executePptGenerate(
      {
        topic: '端点测试',
        content: '# 章节\n要点 1\n要点 2',
        output_path: join(dir, 'out.pptx'),
        research: false,
      },
      makeCtx(dir),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    console.log(
      `[pptGenerate] captured request transport=${captured[0].transport} host=${captured[0].hostname} port=${captured[0].port} path=${captured[0].path} authorization=${captured[0].authorization}`,
    );
    return captured[0];
  }

  it('follows the zhipu base URL filled in settings', async () => {
    h.getSettings.mockReturnValue({
      models: { providers: { zhipu: { baseUrl: FILLED_ZHIPU_BASE_URL } } },
    });

    const req = await captureVlmRequest();

    expect(req.transport).toBe('https');
    expect(req.hostname).toBe('open.bigmodel.cn');
    expect(req.path).toBe('/api/coding/paas/v4/chat/completions');
    expect(Number(req.port)).toBe(443);
    expect(req.authorization).toBe('Bearer zhipu-test-key');
  });

  it('falls back to the default coding endpoint when settings are blank', async () => {
    h.getSettings.mockReturnValue({});

    const req = await captureVlmRequest();

    expect(req.transport).toBe('https');
    expect(req.hostname).toBe(new URL(MODEL_API_ENDPOINTS.zhipuCoding).hostname);
    expect(req.hostname).toBe('api.0ki.cn');
    expect(req.path).toBe('/api/coding/paas/v4/chat/completions');
    expect(Number(req.port)).toBe(443);
    expect(req.authorization).toBe('Bearer zhipu-test-key');
  });

  it('keeps a non-443 port from the filled base URL', async () => {
    h.getSettings.mockReturnValue({
      models: { providers: { zhipu: { baseUrl: 'https://open.bigmodel.cn:8443/api/coding/paas/v4' } } },
    });

    const req = await captureVlmRequest();

    expect(req.transport).toBe('https');
    expect(req.hostname).toBe('open.bigmodel.cn');
    expect(String(req.port)).toBe('8443');
    expect(req.path).toBe('/api/coding/paas/v4/chat/completions');
    expect(req.authorization).toBe('Bearer zhipu-test-key');
  });

  it('uses http.request for an http base URL (e.g. a local capture server)', async () => {
    h.getSettings.mockReturnValue({
      models: { providers: { zhipu: { baseUrl: 'http://127.0.0.1:9988/v4' } } },
    });

    const req = await captureVlmRequest();

    expect(req.transport).toBe('http');
    expect(req.hostname).toBe('127.0.0.1');
    expect(String(req.port)).toBe('9988');
    expect(req.path).toBe('/v4/chat/completions');
    expect(req.authorization).toBe('Bearer zhipu-test-key');
    expect(h.httpsRequest).not.toHaveBeenCalled();
  });
});
