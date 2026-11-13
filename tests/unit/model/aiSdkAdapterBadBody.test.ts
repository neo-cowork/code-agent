// HTTP 200 但响应体不可用（截断 JSON / 空体 / HTML）：走真 `ai` SDK + 本地 HTTP 服务，
// 经 inferenceViaAiSdk 公共入口验证 分类日志 / 至多一次重试 / 终态人话。
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import type { StreamChunk } from '../../../src/host/model/types';
import type { ModelConfig } from '../../../src/shared/contract';
import { INCOMPLETE_RESPONSE_DIAGNOSTIC } from '../../../src/shared/modelErrorDiagnostics';

const warns: string[] = [];
let port = 0;
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), error: vi.fn(), debug: vi.fn(),
    warn: (...a: unknown[]) => { warns.push(a.map(String).join(' ')); },
  }),
}));
vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: () => `http://127.0.0.1:${port}/v1`,
  resolveProviderApiKey: () => 'test-key',
}));

const CONFIG = { provider: 'xiaomi', model: 'mimo-v2.6-flash', temperature: 0.7 } as ModelConfig;
const BAD = {
  truncated_json: { type: 'application/json', body: '{"id":"x","choices":[{"mess' },
  empty_body: { type: 'application/json', body: '' },
  html_page: { type: 'text/html', body: '<html><body>Bad gateway page</body></html>' },
  transport_cut: { type: 'application/json', body: '{"id":"x","choices":[{"mess', cut: true },
  wrong_shape: { type: 'application/json', body: '{"unexpected":true}' },
} as const;
type BadName = keyof typeof BAD;

const GOOD_JSON = JSON.stringify({
  id: 'c1', object: 'chat.completion', created: 1, model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const GOOD_SSE = [
  { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
  { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
].map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';

// 每次请求按队列出：数组耗尽后一律回好体
let queue: Array<BadName | 'good' | 'sse_text_plain' | 'sse_json'> = [];
let hits = 0;
let streamRequests = 0;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    hits += 1;
    const wantsStream = /"stream"\s*:\s*true/.test(Buffer.concat(chunks).toString());
    if (wantsStream) streamRequests += 1;
    const next = queue.shift() ?? 'good';
    if (next === 'good') {
      res.writeHead(200, { 'content-type': wantsStream ? 'text/event-stream' : 'application/json' });
      res.end(wantsStream ? GOOD_SSE : GOOD_JSON);
      return;
    }
    if (next === 'sse_text_plain' || next === 'sse_json') {
      // 合法 SSE，但中转站把 content-type 标成 text/plain / application/json
      res.writeHead(200, { 'content-type': next === 'sse_json' ? 'application/json' : 'text/plain' });
      res.end(GOOD_SSE);
      return;
    }
    const bad = BAD[next];
    if ('cut' in bad) {
      res.writeHead(200, { 'content-type': bad.type, 'content-length': '900' });
      res.write(bad.body);
      setTimeout(() => res.destroy(), 30);
      return;
    }
    res.writeHead(200, { 'content-type': bad.type });
    res.end(bad.body);
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});
afterAll(() => { server.close(); });
beforeEach(() => { warns.length = 0; hits = 0; streamRequests = 0; queue = []; });

const MSGS = [{ role: 'user' as const, content: 'hi' }];
function run(mode: 'generate' | 'stream') {
  const chunks: StreamChunk[] = [];
  const onStream = mode === 'stream' ? (c: StreamChunk | string) => { if (typeof c !== 'string') chunks.push(c); } : undefined;
  return { chunks, promise: inferenceViaAiSdk(MSGS, [], CONFIG, onStream) };
}

const RETRYABLE: BadName[] = ['truncated_json', 'empty_body', 'html_page', 'transport_cut'];
const EXPECT_CLASS: Record<string, string> = {
  truncated_json: 'truncated_json', empty_body: 'empty_body', html_page: 'html_page', transport_cut: 'truncated_json',
};

describe.each(['generate', 'stream'] as const)('inferenceViaAiSdk 2xx 坏响应体（%s）', (mode) => {
  it.each(RETRYABLE)('%s：warn 带类别与原文片段；坏体后好体 → 恰好重试一次后成功', async (name) => {
    queue = [name];
    const { promise } = run(mode);
    const res = await promise;
    expect(res.content).toBe('hello');
    expect(hits).toBe(2);
    if (mode === 'stream') expect(streamRequests).toBe(2);
    const line = warns.find((w) => w.includes('2xx 响应体不可用'));
    expect(line).toContain(`class=${EXPECT_CLASS[name]}`);
    const bad = BAD[name];
    if (name !== 'transport_cut' && bad.body) expect(line).toContain(`snippet=${JSON.stringify(bad.body.slice(0, 200))}`);
  }, 30000);

  it.each(RETRYABLE)('%s：连续两次坏体 → 只重试一次即停，终态是人话诊断', async (name) => {
    queue = [name, name, name, name];
    const { promise, chunks } = run(mode);
    const err = await promise.then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(hits).toBe(2);
    expect(err!.message).toBe(`${INCOMPLETE_RESPONSE_DIAGNOSTIC.message}\n建议：${INCOMPLETE_RESPONSE_DIAGNOSTIC.suggestion}`);
    expect(err!.message).not.toMatch(/Failed to process|Invalid JSON|AI_|\{"/);
    expect(warns.filter((w) => w.includes('2xx 响应体不可用'))).toHaveLength(2);
    if (mode === 'stream') {
      const errChunk = chunks.find((c) => c.type === 'error');
      expect(errChunk?.error).toContain(INCOMPLETE_RESPONSE_DIAGNOSTIC.message);
    }
  }, 30000);

  it('合法 JSON 但结构不符（other）：不重试，原样失败', async () => {
    queue = ['wrong_shape', 'wrong_shape'];
    const { promise } = run(mode);
    if (mode === 'generate') {
      const err = await promise.then(() => null, (e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).not.toContain(INCOMPLETE_RESPONSE_DIAGNOSTIC.message);
      expect(hits).toBe(1);
      expect(warns.some((w) => w.includes('class=other'))).toBe(true);
    } else {
      // 流式：合法 JSON 的 200 原样放行（与改动前一致），只保证不重放
      await promise.catch(() => undefined);
      expect(hits).toBe(1);
    }
  }, 30000);
});

describe('inferenceViaAiSdk 流式：content-type 标错的合法 SSE', () => {
  it.each(['sse_text_plain', 'sse_json'] as const)('%s：不被当坏体，不重试，正常出字', async (name) => {
    queue = [name];
    const { promise, chunks } = run('stream');
    const res = await promise;
    expect(res.content).toBe('hello');
    expect(hits).toBe(1);
    expect(warns.some((w) => w.includes('2xx 响应体不可用'))).toBe(false);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
  }, 30000);
});
