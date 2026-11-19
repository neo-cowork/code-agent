import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const axiosFn = vi.hoisted(() => {
  const fn = vi.fn();
  return Object.assign(fn, { isCancel: vi.fn(() => false) });
});
vi.mock('axios', () => ({ default: axiosFn }));

import { makeAiSdkFetch } from '../../../src/host/model/adapters/aiSdkFetch';

// N-EVAL-CI-NOEXIT：消费方提前停读（abort / 出错）时 Readable.toWeb 只销毁中间 Transform，
// 不顺 pipe 销毁 axios 源响应流——IncomingMessage + zlib + keep-alive socket 常驻事件循环
// （09-02 持有者点名：STREAM_END_OF_STREAM 553 / ZLIB 79）。修复=Transform 关闭时销毁源流。
// 反向变异 M2：删掉 transform.once('close', …) 的销毁 ⇒ 第一个用例红（源流永不销毁）。
describe('aiSdkFetch 响应流收尾（N-EVAL-CI-NOEXIT）', () => {
  it('消费方 cancel web stream 后，底层 axios 响应流被销毁', async () => {
    const source = new Readable({ read() {} }); // 永不结束的源响应流（模型连接挂着没发完的形态）
    axiosFn.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: source });

    const fetchFn = makeAiSdkFetch();
    const response = await fetchFn('https://api.example.com/v1/chat/completions', { method: 'POST' });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const sourceClosed = new Promise<void>((resolve) => source.once('close', () => resolve()));

    await reader.cancel('consumer stopped');
    await Promise.race([
      sourceClosed,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('source stream not destroyed')), 5000)),
    ]);
    expect(source.destroyed).toBe(true);
  });

  it('正常读完的响应流行为不变：内容完整、不报错', async () => {
    const payload = 'data: {"choices":[]}\n\ndata: [DONE]\n\n';
    const source = Readable.from([Buffer.from(payload)]);
    axiosFn.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: source });

    const fetchFn = makeAiSdkFetch();
    const response = await fetchFn('https://api.example.com/v1/chat/completions', { method: 'POST' });
    const text = await response.text();
    expect(text).toBe(payload);
  });
});

function sseOk(text: string) {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/event-stream' },
    data: Readable.from([Buffer.from(text)]),
  };
}

function rejected(status: number, text: string) {
  return {
    status,
    statusText: status === 422 ? 'Unprocessable Entity' : 'Bad Request',
    headers: { 'content-type': 'application/json' },
    data: Readable.from([Buffer.from(text)]),
  };
}

const relayBody = (model: string) => JSON.stringify({
  model,
  stream: true,
  reasoning_effort: 'high',
  messages: [{ role: 'user', content: 'hi' }],
});

describe('makeAiSdkFetch reasoning_effort strip-retry', () => {
  it('400 with reasoning_effort retries once without it, then the same url+model omits it up front', async () => {
    const url = 'https://relay-strip.example/v1/chat/completions';
    const seen: unknown[] = [];
    const firstBody = Readable.from([Buffer.from('{"code":"MODEL_CALL_FAILED"}')]);
    axiosFn.mockReset();
    axiosFn.mockImplementation(async (config: { data?: unknown }) => {
      seen.push(config.data);
      const parsed = JSON.parse(String(config.data)) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(parsed, 'reasoning_effort')) {
        return {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'content-type': 'application/json' },
          data: firstBody,
        };
      }
      return sseOk('data: {"choices":[]}\n\n');
    });

    const fetchFn = makeAiSdkFetch('custom', undefined, { dropRejectedReasoningEffort: true });
    const init = { method: 'POST', body: relayBody('m-strip'), headers: { 'content-type': 'application/json' } };
    const first = await fetchFn(url, init);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('choices');
    expect(seen).toHaveLength(2);
    expect(JSON.parse(String(seen[0])).reasoning_effort).toBe('high');
    expect(JSON.parse(String(seen[1])).reasoning_effort).toBeUndefined();
    expect(firstBody.destroyed).toBe(true);

    const second = await fetchFn(url, init);
    expect(second.status).toBe(200);
    expect(seen).toHaveLength(3);
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(String(seen[2])), 'reasoning_effort')).toBe(false);
  });

  it('does not retry a 400 that never sent reasoning_effort, and a 500 is not a strip signal', async () => {
    const fetchFn = makeAiSdkFetch('custom', undefined, { dropRejectedReasoningEffort: true });
    axiosFn.mockReset();
    axiosFn.mockResolvedValue(rejected(400, '{"code":"MODEL_CALL_FAILED"}'));
    const plain = await fetchFn('https://relay-plain.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm-plain', stream: true, messages: [] }),
    });
    expect(plain.status).toBe(400);
    expect(axiosFn).toHaveBeenCalledTimes(1);

    axiosFn.mockReset();
    axiosFn.mockResolvedValue(rejected(500, '{"code":"UPSTREAM"}'));
    const serverError = await fetchFn('https://relay-500.example/v1/chat/completions', {
      method: 'POST',
      body: relayBody('m-500'),
    });
    expect(serverError.status).toBe(500);
    expect(axiosFn).toHaveBeenCalledTimes(1);
  });

  it('returns the second 400 unchanged and does not send a third request', async () => {
    const bodies = ['{"n":1}', '{"n":2}'];
    let n = 0;
    axiosFn.mockReset();
    axiosFn.mockImplementation(async () => rejected(400, bodies[n++] ?? '{"n":9}'));
    const fetchFn = makeAiSdkFetch('custom', undefined, { dropRejectedReasoningEffort: true });
    const response = await fetchFn('https://relay-both.example/v1/chat/completions', {
      method: 'POST',
      body: relayBody('m-both'),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"n":2}');
    expect(n).toBe(2);
  });

  it('does not retry when the signal is already aborted, or when axios rejects the aborted call', async () => {
    const controller = new AbortController();
    controller.abort();
    axiosFn.mockReset();
    axiosFn.mockResolvedValue(rejected(400, '{"code":"MODEL_CALL_FAILED"}'));
    const fetchFn = makeAiSdkFetch('custom', undefined, { dropRejectedReasoningEffort: true });
    const response = await fetchFn('https://relay-abort.example/v1/chat/completions', {
      method: 'POST',
      body: relayBody('m-abort'),
      signal: controller.signal,
    });
    expect(response.status).toBe(400);
    expect(axiosFn).toHaveBeenCalledTimes(1);

    axiosFn.mockReset();
    axiosFn.mockRejectedValue(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' }));
    await expect(fetchFn('https://relay-abort-throw.example/v1/chat/completions', {
      method: 'POST',
      body: relayBody('m-abort-throw'),
      signal: controller.signal,
    })).rejects.toThrow('aborted');
    expect(axiosFn).toHaveBeenCalledTimes(1);
  });

  it('retries a 422 the same way, and stays off unless the openai-compatible branch opts in', async () => {
    const seen: unknown[] = [];
    axiosFn.mockReset();
    axiosFn.mockImplementation(async (config: { data?: unknown }) => {
      seen.push(config.data);
      const parsed = JSON.parse(String(config.data)) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(parsed, 'reasoning_effort')) return rejected(422, '{"code":"MODEL_CALL_FAILED"}');
      return sseOk('data: {"ok":true}\n\n');
    });
    const optedIn = makeAiSdkFetch('custom', undefined, { dropRejectedReasoningEffort: true });
    const ok = await optedIn('https://relay-422.example/v1/chat/completions', {
      method: 'POST',
      body: relayBody('m-422'),
    });
    expect(ok.status).toBe(200);
    expect(seen).toHaveLength(2);

    axiosFn.mockReset();
    axiosFn.mockResolvedValue(rejected(400, '{"code":"MODEL_CALL_FAILED"}'));
    const plain = makeAiSdkFetch('custom');
    const denied = await plain('https://relay-optout.example/v1/chat/completions', {
      method: 'POST',
      body: relayBody('m-optout'),
    });
    expect(denied.status).toBe(400);
    expect(axiosFn).toHaveBeenCalledTimes(1);
  });
});
