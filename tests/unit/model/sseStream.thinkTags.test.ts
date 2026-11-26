import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { openAISSEStream } from '../../../src/host/model/providers/sseStream';

type Exit = 'done' | 'end';

describe('openAISSEStream think-tag extraction (真实 provider chunk 形状 + 本地 fake SSE)', () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function run(chunks: string[], exit: Exit, finish = 'stop') {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      chunks.forEach((c, i) => {
        const choice: Record<string, unknown> = { index: 0, delta: { content: c } };
        if (i === chunks.length - 1 && finish) choice.finish_reason = finish;
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [choice] })}\n\n`);
      });
      if (exit === 'done') res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    const result = await openAISSEStream({
      providerName: 'TestProvider',
      baseUrl: `http://127.0.0.1:${addr.port}`,
      apiKey: 'k',
      requestBody: { model: 't', messages: [], stream: true },
    });
    return result as { content?: string; reasoning?: string; thinking?: string };
  }
  const thought = (r: { reasoning?: string; thinking?: string }) => r.reasoning ?? r.thinking ?? '';

  for (const exit of ['done', 'end'] as Exit[]) {
    describe(`exit=${exit}`, () => {
      it('① 孤儿 </think>：前→reasoning，后→content，标签不残留', async () => {
        const r = await run(['先分析合同条款，', '再整理要点。</think>', '合同摘要：甲方付款。'], exit);
        expect(r.content).toBe('合同摘要：甲方付款。');
        expect(thought(r)).toBe('先分析合同条款，再整理要点。');
      });

      it('③ 闭标签被拆成两个 chunk：结果相同', async () => {
        const r = await run(['先分析合同条款，再整理要点。</th', 'ink>合同摘要：', '甲方付款。'], exit);
        expect(r.content).toBe('合同摘要：甲方付款。');
        expect(thought(r)).toBe('先分析合同条款，再整理要点。');
      });

      it('② 完整块：行为不变', async () => {
        const r = await run(['<thi', 'nk>推理</think>答案'], exit);
        expect(r.content).toBe('答案');
        expect(thought(r)).toBe('推理');
      });

      it('② 未闭合 <think>：行为不变', async () => {
        const r = await run(['答案前缀<think>推理没写完'], exit, '');
        expect(r.content).toBe('答案前缀');
        expect(thought(r)).toBe('推理没写完');
      });
    });
  }

  it('② 截断流（finish_reason=length）+ 孤儿闭标签：不泄漏', async () => {
    const r = await run(['推理片段</think>半截答案'], 'done', 'length');
    expect(r.content).toBe('半截答案');
    expect(thought(r)).toBe('推理片段');
  });
});
