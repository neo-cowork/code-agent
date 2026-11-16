// N-FIX-TOKENRHYTHM-RESPONSES-WEB-SEARCH-400：中继对 Responses 内置 web_search 返回
// 400 RESPONSES_FEATURE_NOT_SUPPORTED → warn 后去掉该工具重试一次，并按 provider+model
// 记住。全程 mock electronFetch；错误体为 2026-11-15 对真中继的原样抓取。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/model/providers/providerHttp', () => ({ electronFetch }));

import { ResponsesProvider } from '../../../src/host/model/providers/responsesProvider';
import { logger } from '../../../src/host/model/providers/providerRuntime';

const REAL_BODY = '{"error":{"message":"当前模型或上游不支持 Responses 能力：web_search","type":"invalid_request_error","param":null,"code":"RESPONSES_FEATURE_NOT_SUPPORTED"},"traceId":"trace_632bd748-e94c-403e-b8c7-2720a7551d3e"}';

const rejected = (body = REAL_BODY, status = 400) => ({ ok: false, status, text: vi.fn().mockResolvedValue(body) });
const ok = () => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }), text: vi.fn() });
const fnTool = { name: 'read_file', description: 'd', inputSchema: { type: 'object', properties: {} } };
const bodies = () => electronFetch.mock.calls.map((c) => JSON.parse(c[1].body as string));

describe('ResponsesProvider web_search feature rejection', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    electronFetch.mockReset();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('retries once without web_search, keeps other tools, remembers per provider+model', async () => {
    // 走 official deepseek 的矩阵（deepseek-responses）以确保首发带 web_search
    const call = () => new ResponsesProvider().inference(
      [{ role: 'user', content: 'hi' }], [fnTool] as any,
      { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'k', protocol: 'responses' } as any,
    );
    electronFetch.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(ok());
    await call();
    let sent = bodies();
    expect(sent).toHaveLength(2);
    expect(sent[0].tools.some((t: any) => t.type === 'web_search')).toBe(true);
    expect(sent[1].tools.some((t: any) => t.type === 'web_search')).toBe(false);
    expect(sent[1].tools.some((t: any) => t.name === 'read_file')).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('web_search rejected'), expect.objectContaining({
      provider: 'deepseek', model: 'deepseek-v4-flash', status: 400, code: 'RESPONSES_FEATURE_NOT_SUPPORTED',
    }));

    electronFetch.mockClear();
    electronFetch.mockResolvedValueOnce(ok());
    await call();
    sent = bodies();
    expect(sent).toHaveLength(1);
    expect(sent[0].tools.some((t: any) => t.type === 'web_search')).toBe(false);
  });

  it('does not retry a 400 with another code', async () => {
    electronFetch.mockResolvedValue(rejected('{"error":{"code":"invalid_value","param":"x"}}'));
    await expect(new ResponsesProvider().inference(
      [{ role: 'user', content: 'hi' }], [],
      { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', protocol: 'responses' } as any,
    )).rejects.toThrow(/Responses API \(400\)/);
    expect(electronFetch).toHaveBeenCalledTimes(1);
  });

  it('when the retry also fails the error is thrown with the status and body (feeds the failure card)', async () => {
    electronFetch.mockResolvedValue(rejected());
    await expect(new ResponsesProvider().inference(
      [{ role: 'user', content: 'hi' }], [],
      { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', protocol: 'responses' } as any,
    )).rejects.toThrow(/Responses API \(400\).*RESPONSES_FEATURE_NOT_SUPPORTED/);
    expect(electronFetch).toHaveBeenCalledTimes(2);
  });
});
